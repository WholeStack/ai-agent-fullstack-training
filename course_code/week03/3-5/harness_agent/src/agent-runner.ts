// 在 3.1 的 pi Loop 上接入计划层。
// 复用原有接缝，不另写循环：
//   beforeToolCall   计划门禁 + 原重复保护
//   afterToolCall    保存证据 + 原交付物观测
//   prepareNextTurn  刷新计划快照，不堆积历史
//   shouldStopAfterTurn 完成契约 + 原轮数限制
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  runAgentLoop,
  runAgentLoopContinue,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentToolCall,
  type AfterToolCallContext,
  type AgentMessage,
  type Session,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

import { ApprovalGate } from "./approval.js";
import { applyApprovedPatch, rejectPendingPatch } from "./approval-flow.js";
import {
  computeRepoDigest,
  saveCheckpoint,
  type CheckpointEnvelope,
  type WorkspaceReference,
} from "./checkpoint.js";
import {
  createLoginFixContract,
  type CompletionContract,
} from "./completion-contract.js";
import { LoopGuard, type LoopState } from "./loop-guard.js";
import { createDurableJournal } from "./journal.js";
import { createPlanningAgentTools } from "./pi-tools.js";
import { PLANNING_PROMPT, renderPlanSnapshot } from "./planning-prompt.js";
import { PlanningSession, type PlanSnapshot, type StepVerifier } from "./plan-store.js";
import { createExecutionContext, type DemoExecutionContext } from "./run-context.js";
import { DemoToolRuntime } from "./runtime.js";
import { TaskRecorder, isTerminalStatus, type TaskRecord } from "./task-record.js";
import { ResumeRejected } from "./resume.js";
import type { Evidence } from "./plan-store.js";

export interface TraceEvent {
  type: AgentEvent["type"];
  turn: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface RunPlanningAgentOptions {
  model: Model<any>;
  streamFn: StreamFn;
  maxTurns?: number;
  maxRevisions?: number;
  maxToolCalls?: number;
  signal?: AbortSignal;
  executionContext?: DemoExecutionContext;
  runtime?: DemoToolRuntime;
  taskPrompt?: string;
  verifyStep?: StepVerifier;
  contract?: CompletionContract;
  onText?: (delta: string) => void;
  /** R2：存档目录（projectRoot）。默认取 executionContext.projectRoot。 */
  checkpointRoot?: string;
  /** 强制关闭存档（仅用于不关心恢复的测试）。 */
  disableCheckpoint?: boolean;
  /** 指定 runId（恢复时沿用原 runId）。 */
  runId?: string;
  /** 恢复时注入的已有会话与记录。 */
  restore?: {
    task: TaskRecord;
    messages: AgentMessage[];
    session?: Session;
    /** R3：还原业务对象——计划与证据。 */
    plan?: PlanSnapshot;
    evidence?: Evidence[];
  };
  /**
   * 人工决定：把存档里的待审批补丁批准或拒绝掉。
   * 决定只在这个进程里生效，不写进存档的 approved 字段——
   * 进程重启不会"继承批准"。人工入口传 manual，--auto-approve 传 auto。
   */
  operatorDecision?: {
    decision: "approve" | "reject";
    by: "manual" | "auto";
    reason?: string;
  };
  /** 注入点位（仅测试用）：在存档/落盘之间制造崩溃。 */
  crashPoint?: string;
  /**
   * 人工接管开关：自动批准待审批补丁。
   *   false（默认）——apply_patch 暂存后进入 waiting_approval，等待人工决定；
   *   true         ——补丁仍走完整的暂存 / 校验 / patchHash 比对流程，
   *                   但由机器当场批准并落盘，并在 decisions 中留下
   *                   "auto：自动批准" 的记录，供随后的审批实验对照。
   */
  autoApprove?: boolean;
  /**
   * 自动暂停点：在第 N 个完整轮次结束、存档写盘之后暂停运行。
   * 与 crashPoint 的强制退出不同，这里是一次优雅暂停：
   * 进程正常退出（exit 0），任务状态仍是 running（不是失败，也没终结），
   * 存档完整可用。
   */
  pauseAfter?: number;
}

export interface RunPlanningAgentResult {
  state: LoopState;
  /** 本次运行的会话历史（恢复时含存档里已有的部分）。 */
  messages: AgentMessage[];
  /**
   * 进入 Loop 的方式：
   *   prompt   —— 新运行（或存档里没有会话历史）：从任务输入起步；
   *   continue —— 恢复：把存档里的会话历史回灌给 pi 的续跑入口。
   */
  resumeEntry: "prompt" | "continue";
  trace: TraceEvent[];
  runtime: DemoToolRuntime;
  session: PlanningSession;
  /** R1：任务与步骤记录。 */
  record: TaskRecord;
  /** R4：审批门。 */
  approval: ApprovalGate;
  /** R2：存档写入结果。 */
  checkpoints: CheckpointEnvelope[];
  /** pi journal 会话引用。 */
  journal?: Session;
}

export const DEFAULT_TASK_PROMPT = [
  "修复登录模块的失败测试，并补充回归验证。",
  "约束：只修改 src/auth/session-policy.ts；不得改变公共 API。",
  "目标用例与约定的登录模块回归必须通过。",
  "完成后把根因、改动、验证命令与未验证项写入 artifacts/login-fix.md。",
].join("\n");

/** 存档停在"助手刚说完话"的轮次时补的推进提示：pi 的续跑入口不接受 assistant 结尾。 */
const RESUME_CONTINUE_HINT = "继续推进计划中未完成的步骤，直到完成契约满足。";

/** journal 中标记为「不可重放」的工具：所有会产生副作用的写操作。 */
const GOVERNED_JOURNAL_TOOLS = new Set([
  "write_file",
  "apply_patch",
  "run_test",
]);

const BASE_SYSTEM_PROMPT = [
  "你是代码任务 Agent。",
  "所有面向用户的自然语言回复必须使用简体中文，不要使用英文解释或英文总结。",
  "工具调用参数中的路径、命令、代码和标识符保持原样，不要翻译。",
  "先取证，再改代码：读取真实实现、复现失败，然后做最小修改。",
  "不得根据文件名猜测实现，不得删除或弱化测试断言。",
].join("\n");

function composeSystemPrompt(base: string, session: PlanningSession): string {
  return [
    base,
    PLANNING_PROMPT,
    renderPlanSnapshot(session.snapshot(), session.evidence.list()),
  ].join("\n\n");
}

export async function runPlanningAgent(
  options: RunPlanningAgentOptions,
): Promise<RunPlanningAgentResult> {
  if (options.restore && isTerminalStatus(options.restore.task.status)) {
    throw new ResumeRejected("RUN_TERMINAL", `运行已处于终态（${options.restore.task.status}），不再续跑。`);
  }
  const executionContext = options.executionContext ?? createExecutionContext();
  const runtime = options.runtime ?? new DemoToolRuntime();
  const session = new PlanningSession({
    maxRevisions: options.maxRevisions ?? 2,
    verifyStep: options.verifyStep,
    getRevision: () => runtime.getRevision(),
  });
  // R3：先校验通过后，还原计划与证据，保留版本/修订历史/步骤状态。
  if (options.restore?.plan) {
    const restorePlan = options.restore.plan;
    const { revisions, executedSteps, ...plan } = restorePlan;
    void executedSteps;
    session.restore({
      plan,
      revisions: revisions ?? [],
      evidence: options.restore.evidence ?? [],
    });
  }
  // 代码版本对齐：以证据里记录过的最高版本为基准即可。
  // 存档自身是一致的（暂停发生在存档写完之后），证据的 artifactVersion
  // 就是当时真实的代码版本；这里绝不能因为"工作区里能搜到补丁片段"
  // 就再推进一版——那会让刚对齐的证据立刻变成过期证据，
  // 反向触发 PLAN_EVIDENCE_STALE。
  if (options.restore) {
    const archived = options.restore.evidence ?? [];
    const highest = archived.reduce((max: number, item) => {
      const matched = /^r(\d+)$/.exec(item.artifactVersion);
      return matched ? Math.max(max, Number(matched[1])) : max;
    }, 0);
    runtime.restoreRevision(`r${highest}`);
  }
  const contract = options.contract ?? createLoginFixContract({
    targetSource: executionContext.targetSource,
    targetArtifact: executionContext.targetArtifact,
  });
  const state = createLoopState(options.maxTurns ?? 80);

  // R1：任务记录；恢复时从存档还原，计数与失败历史原样保留。
  const restored = options.restore;
  const runId = options.runId ?? restored?.task.runId ?? state.runId;
  state.runId = runId;
  const recorder = restored
    ? TaskRecorder.restore(restored.task)
    : new TaskRecorder({
      runId,
      taskInput: options.taskPrompt ?? DEFAULT_TASK_PROMPT,
      // 计划尚未创建，先用空步骤；create_plan 后记录层按需扩展。
      steps: [],
      counters: {
        turn: 0,
        maxTurns: options.maxTurns ?? 80,
        toolCalls: 0,
        maxToolCalls: options.maxToolCalls ?? 200,
        revisions: 0,
        maxRevisions: options.maxRevisions ?? 2,
        checkpoints: 0,
      },
    });
  if (restored) {
    // 恢复时把轮数续上，避免被当成新一轮重新计数。
    state.turn = restored.task.counters.turn;
    // 续跑本身不改变任务状态：暂停后仍是 running，等待审批后仍是 waiting_approval。
    recorder.transition("task_resumed", recorder.status, "restored from checkpoint");
  }

  const approval = new ApprovalGate();
  // 待审批动作跟着存档走：换一个进程重新审批，必须看到同一份补丁与同一个 patchHash。
  // approved 一定从 false 开始——批准只在做出决定的那次进程里有效。
  const archivedPending = recorder.pendingApproval;
  if (archivedPending) {
    approval.restore(archivedPending);
  }
  const checkpointRoot = options.checkpointRoot ?? executionContext.projectRoot;
  const checkpoints: CheckpointEnvelope[] = [];

  // 人工决定在续跑之前落地：拒绝就不启动模型，批准则先落盘再继续。
  let operatorRejected = false;
  const decided = options.operatorDecision;

  // 工作区标识与「相关文件」清单，用于 R2 摘要与 R3 差异检测。
  const digestFiles = [
    executionContext.targetSource,
    ...executionContext.targetSuite.files,
    ...executionContext.boundarySuite.files,
    ...executionContext.regressionSuite.files,
  ];

  // pi 的低层会话 journal（JSONL 落盘）：跨进程保留操作边界，
  // 供恢复时判定「上次动作」三态。
  const journal = restored?.session ?? (await createDurableJournal({ checkpointRoot }));
  const lane = "main";
  const operationId = runId;

  /**
   * --pause-after <N>：第 N 个完整轮次结束、存档落盘之后，优雅暂停。
   * 与 crashPoint 的区别：这里进程正常退出（exit 0），
   * 任务状态仍是 running（只是停下来，不是失败，也没有终结），存档完整可恢复。
   */
  const pauseAfter = options.pauseAfter;
  const pauseWanted = typeof pauseAfter === "number" && Number.isFinite(pauseAfter);
  let paused = false;

  // `reason` 形如 turn-N / final。
  const persist = async (reason: string): Promise<void> => {
    if (options.disableCheckpoint) return;
    // 测试用崩溃点：模拟「业务动作已完成、下一份存档尚未写」。
    if (options.crashPoint === "before-checkpoint" && reason.startsWith("turn-")) {
      process.exit(137);
    }
    const workspace: WorkspaceReference = {
      id: `${path.basename(executionContext.projectRoot)}:${executionContext.projectRoot}`,
      repoRoot: executionContext.repoRoot,
      projectRoot: executionContext.projectRoot,
      codeRevision: runtime.getRevision(),
      digestFiles,
      repoDigest: await computeRepoDigest(executionContext.repoRoot, digestFiles),
    };
    // 存档序号在写盘之前推进：存档里记的就是"这一份是第几份"。
    recorder.countCheckpoint();
    const envelope = await saveCheckpoint({
      projectRoot: checkpointRoot,
      runId,
      task: recorder.snapshot(),
      plan: session.snapshot(),
      evidence: session.evidence.list(),
      messages: history,
      sessionId: journal ? (await journal.getMetadata()).id : undefined,
      lastOperationId: reason,
      workspace,
    });
    checkpoints.push(envelope);
    // 暂停点判定：必须等存档真正写完之后，才允许暂停，
    // 否则恢复时会落进"结果不明"分支，暂停实验就变成崩溃实验了。
    if (
      pauseWanted
      && !paused
      && reason.startsWith("turn-")
      && state.turn >= pauseAfter!
    ) {
      paused = true;
      state.stopCode = "INTERRUPTED";
      // 自环迁移：任务仍在 running，只是停在这个存档点上。
      recorder.transition(
        "task_interrupted",
        "running",
        `第 ${state.turn} 轮结束，存档 seq=${envelope.seq}`,
      );
    }
    // 测试用崩溃点：存档已写、进程被杀；恢复应能正常继续。
    // 支持 "after-checkpoint:3" 只在第 3 轮后崩溃。
    const afterCheckpoint = options.crashPoint?.startsWith("after-checkpoint");
    if (afterCheckpoint && reason.startsWith("turn-")) {
      const target = Number(options.crashPoint?.split(":")[1] ?? "0");
      if (!target || reason === `turn-${target}`) {
        process.exit(137);
      }
    }
  };

  const recordedToolCalls = new Set<string>();
  const observedToolResults = new Set<string>();
  const pendingToolCalls = new Map<string, {
    assistantMessage: AfterToolCallContext["assistantMessage"];
    toolCall: AgentToolCall;
  }>();
  const guard = new LoopGuard(state, {
    session,
    contract,
    getRevision: () => runtime.getRevision(),
    getCompletionState: () => runtime.captureCompletionState(executionContext),
    recorder,
    isAwaitingApproval: () => approval.peek() !== undefined,
    crashOnToolStart: options.crashPoint === "during-test" ? "run_test" : undefined,
    onTurnCheckpoint: async () => {
      // R2：默认在完整轮次结束后保存。由 observeEvent 的 turn_end 驱动。
    },
    // journal：记录工具启动，写操作 replay:"never"，读操作 replay:"safe"。
    onToolStart: async (info) => {
      recordedToolCalls.add(info.toolCallId);
      if (!journal) return;
      await journal.appendRecord({
        type: "tool_started",
        id: `${operationId}:${info.toolCallId}`,
        lane,
        runId: operationId,
        assistantEntryId: `turn-${state.turn}`,
        toolIndex: 0,
        toolCallId: info.toolCallId,
        toolName: info.toolName,
        effectiveArgs: info.args,
        resultEntryId: info.toolCallId,
        replay: GOVERNED_JOURNAL_TOOLS.has(info.toolName) ? "never" : "safe",
      }).catch(() => undefined);
    },
  });
  const trace: TraceEvent[] = [];
  // 会话历史：存档与续跑共用同一份真实累积的历史（恢复时先接上存档里的）。
  // 不能直接用 context.messages 存存档——pi 的 Loop 内部是
  // {...context, messages: [...]} 的副本，从不回写调用方的这个数组。
  const history: AgentMessage[] = [...(restored?.messages ?? [])];
  const context: AgentContext = {
    systemPrompt: composeSystemPrompt(BASE_SYSTEM_PROMPT, session),
    messages: [...history],
    tools: createPlanningAgentTools(runtime, executionContext, session, {
      approval,
      recorder,
      autoApprove: options.autoApprove,
      // 测试用 A2：批准并落盘后、下一份存档前强制退出。
      // 覆盖循环内的 --auto-approve 路径；人工决定路径的同一崩溃点
      // 由上面的 operatorDecision 分支注入。
      onAfterApproval: options.crashPoint === "after-approval-before-checkpoint"
        ? async () => { process.exit(137); }
        : undefined,
    }),
  };
  const prompt: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: options.taskPrompt ?? DEFAULT_TASK_PROMPT }],
    timestamp: Date.now(),
  };

  // 进入 Loop 的方式：存档里有会话历史就回灌给 pi 的续跑入口，
  // 而不是把任务输入再发一遍（那会让模型从头重做一遍已经做过的事）。
  // pi 的续跑入口要求历史非空、且最后一条不是 assistant：若存档停在
  // "助手刚说完话"的轮次，续跑前补一条推进提示，否则续跑入口会直接抛错。
  const resumeEntry: "prompt" | "continue" =
    history.length === 0 ? "prompt" : "continue";
  if (resumeEntry === "continue" && history[history.length - 1]?.role === "assistant") {
    const hint: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: RESUME_CONTINUE_HINT }],
      timestamp: Date.now(),
    };
    context.messages.push(hint);
    history.push(hint);
  }

  // 开始一次操作（journal）：恢复时 findOpenOperations 能识别未闭合的运行。
  if (journal) {
    await journal.appendRecord({
      type: "operation_started",
      id: operationId,
      lane,
      sourceLeafId: null,
      intent: {
        kind: "run",
        originalPrompt: [prompt],
        initialMessages: [],
      },
    }).catch(() => undefined);
  }
  const config: AgentLoopConfig = {
    model: options.model,
    convertToLlm: (messages) => messages.filter(isLlmMessage),
    maxRetries: 0,
    toolExecution: "sequential",
    beforeToolCall: async (hookContext) => guard.beforeToolCall(hookContext),
    afterToolCall: async (hookContext) => {
      const isError = hookContext.isError || hookContext.result.details?.ok === false;
      guard.observeToolResult({ ...hookContext, isError });
      observedToolResults.add(hookContext.toolCall.id);
      if (options.signal?.aborted) state.stopCode = "ABORTED";
      return { isError };
    },
    // 每轮刷新计划快照：模型看到的是当前版本，而不是历次计划的堆积。
    prepareNextTurn: async ({ context: nextContext }) => ({
      context: {
        ...nextContext,
        systemPrompt: composeSystemPrompt(BASE_SYSTEM_PROMPT, session),
      },
    }),
    shouldStopAfterTurn: async (hookContext) => guard.afterTurn(hookContext),
    getSteeringMessages: async () => [],
    getFollowUpMessages: async () => guard.drainFollowUps(),
  };
  // 事件回调：观察事件 + 累积会话历史 + 轮次存档，两条入口共用。
  // 会话历史只能自己按事件累积（pi 的 Loop 不会回写 context.messages）：
  //   message_end(role: user) —— 任务输入 / FINAL_REJECTED 追加提示
  //   turn_end                —— 助手消息 + 本轮工具结果
  const onEvent = async (event: AgentEvent): Promise<void> => {
    await observeEvent(event, state, trace, options.onText, recorder);
    if (event.type === "message_end") {
      if (event.message.role === "user") history.push(event.message);
      if (event.message.role === "assistant") {
        for (const item of event.message.content) {
          if (item.type === "toolCall") {
            pendingToolCalls.set(item.id, { assistantMessage: event.message, toolCall: item });
          }
        }
      }
      return;
    }
    if (event.type === "tool_execution_end") {
      const pending = pendingToolCalls.get(event.toolCallId);
      // pi 参数校验失败、未知工具、beforeToolCall 拦截都跳过 afterToolCall。
      // 从真实结束事件补齐记录，不伪造执行，也不把阻塞步骤激活。
      if (pending && !observedToolResults.delete(event.toolCallId)) {
        const args = pending.toolCall.arguments as Record<string, unknown>;
        if (!recordedToolCalls.has(event.toolCallId)) {
          recorder.beginToolCall({ toolCallId: event.toolCallId, toolName: event.toolName, args });
        }
        guard.observeToolResult({ ...pending, args, result: event.result, isError: event.isError, context });
      }
      pendingToolCalls.delete(event.toolCallId);
      recordedToolCalls.delete(event.toolCallId);
      if (options.signal?.aborted) state.stopCode = "ABORTED";
    }
    if (event.type === "turn_end" && event.message.role === "assistant") {
      history.push(event.message, ...event.toolResults);
      // R2：完整轮次结束后保存存档（await，避免异步覆盖）。
      await persist(`turn-${state.turn}`);
    }
  };

  let runError: unknown;
  try {
    options.signal?.throwIfAborted();
    if (decided) {
      if (!archivedPending) {
        throw new Error("APPROVAL_NOT_FOUND：存档中没有待审批动作，无法批准或拒绝。");
      }
      const flowDeps = { approval, runtime, session, recorder, context: executionContext };
      if (decided.decision === "reject") {
        rejectPendingPatch(flowDeps, {
          actionId: archivedPending.actionId,
          by: decided.by,
          reason: decided.reason,
        });
        operatorRejected = true;
        state.stopCode = "APPROVAL_REJECTED";
      } else {
        const committed = await applyApprovedPatch(flowDeps, {
          actionId: archivedPending.actionId,
          by: decided.by,
          reason: decided.reason,
          signal: options.signal,
          onAfterCommit: options.crashPoint === "after-approval-before-checkpoint"
            ? async () => { process.exit(137); }
            : undefined,
        });
        if (!committed.ok) state.stopCode = committed.code;
        // 人工入口在模型之前保存写入，后续模型失败/取消也不会丢掉真实进度。
        await persist("approval");
        context.systemPrompt = composeSystemPrompt(BASE_SYSTEM_PROMPT, session);
      }
    }
    options.signal?.throwIfAborted();
    if (approval.peek() && !state.stopCode) state.stopCode = "WAITING_APPROVAL";
    if (!operatorRejected && !state.stopCode) {
      if (resumeEntry === "continue") {
        await runAgentLoopContinue(context, config, onEvent, options.signal, options.streamFn);
      } else {
        await runAgentLoop([prompt], context, config, onEvent, options.signal, options.streamFn);
      }
    }
  } catch (error) {
    if (!options.signal?.aborted) {
      runError = error;
      state.stopCode = error instanceof Error && "code" in error
        ? String(error.code)
        : "MODEL_ERROR";
      recorder.transition("task_error", approval.peek() ? "suspended" : "failed",
        error instanceof Error ? error.message : String(error));
    }
  }

  // 取消可能发生在工具中或刚写盘后，不能只依赖模型的 stopReason。
  // 禁用存档仅禁用 I/O，不改变记录器的终态语义。
  if (options.signal?.aborted) state.stopCode = "ABORTED";
  if (state.stopCode?.startsWith("ABORTED")) {
    recorder.setStopCode(state.stopCode);
    recorder.transition("task_cancelled", "cancelled", "保留已完成写入与证据；未执行的后续动作已取消。");
  } else {
    recorder.finish(state.stopCode);
  }
  await persist("final");

  // 结束操作（journal）：闭合后 findOpenOperations 不再返回它。
  if (journal) {
    await journal.appendRecord({
      type: "operation_finished",
      id: `${operationId}:finished`,
      lane,
      runId: operationId,
      outcome: state.stopCode === "COMPLETED" ? "completed" : "aborted",
    }).catch(() => undefined);
  }
  if (runError) throw runError;

  return {
    state,
    messages: history,
    resumeEntry,
    trace,
    runtime,
    session,
    record: recorder.snapshot(),
    approval,
    checkpoints,
    journal,
  };
}

/** 建立 pi 的 journal 会话（已改为 JSONL 落盘），见 journal.ts。 */

export function createLoopState(maxTurns: number): LoopState {
  return {
    runId: randomUUID(),
    turn: 0,
    maxTurns,
    actions: new Map(),
    evidence: {
      readFiles: new Set(),
      writtenArtifacts: new Set(),
    },
  };
}

async function observeEvent(
  event: AgentEvent,
  state: LoopState,
  trace: TraceEvent[],
  onText?: (delta: string) => void,
  recorder?: TaskRecorder,
): Promise<void> {
  if (event.type === "turn_start") {
    state.turn += 1;
    // R1：轮数记入运行记录，恢复时可供保留。
    recorder?.advanceTurn();
    trace.push({ type: event.type, turn: state.turn });
    return;
  }
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    onText?.(event.assistantMessageEvent.delta);
    return;
  }
  if (event.type === "tool_execution_start") {
    trace.push({
      type: event.type,
      turn: state.turn,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
    });
    return;
  }
  if (event.type === "tool_execution_end") {
    trace.push({
      type: event.type,
      turn: state.turn,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
    });
    return;
  }
  if (event.type === "turn_end" && event.message.role === "assistant") {
    if (event.message.stopReason === "aborted") state.stopCode = "ABORTED";
    if (event.message.stopReason === "error") state.stopCode = "MODEL_ERROR";
  }
}

function isLlmMessage(
  message: AgentMessage,
): message is Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }> {
  return message.role === "user"
    || message.role === "assistant"
    || message.role === "toolResult";
}
