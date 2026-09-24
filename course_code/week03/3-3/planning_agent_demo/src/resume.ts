// ============================================================================
// 3.3 R3：先检查，再恢复
//
// 固定顺序：① 校验存档 → ② 校验工作区 → ③ 校验任务状态 →
//          ④ 还原业务对象 → ⑤ 调用 pi 的续跑能力。
//
// 「上次动作」三态：
//   completed    —— 有闭合记录（operation_finished / 步骤已 completed）；
//   not_started  —— 没有任何该动作的启动记录；
//   unknown      —— 有启动记录但没有闭合记录（含"补丁已落盘、存档未写"）。
//
// 规则：
//   - 结果不明的「写操作」不得自动重放；
//   - 无法安全确认时，输出核查信息并停止自动推进；
//   - 没有完整测试结果，不能把验证步骤记为完成；
//   - 恢复时保留已有轮数、重试次数和预算消耗。
// ============================================================================

import type { Session } from "@earendil-works/pi-agent-core";

import {
  assertWorkspaceExists,
  CheckpointError,
  computeRepoDigest,
  loadCheckpoint,
  type CheckpointEnvelope,
} from "./checkpoint.js";
import { openDurableJournal } from "./journal.js";
import type { TaskRecord } from "./task-record.js";
import { isTerminalStatus } from "./task-record.js";

/** 上次动作的完成状态。 */
export type ActionState = "completed" | "not_started" | "unknown";

/** 一个「需要确认」的动作：恢复时不允许自动重放。 */
export interface UnresolvedAction {
  actionId: string;
  /** 发起该动作的步骤（若可判定）。 */
  stepId?: string;
  toolName: string;
  state: ActionState;
  reason: string;
}

export interface ResumeInspection {
  runId: string;
  /** 是否允许自动续跑。 */
  canResume: boolean;
  /** 拒绝或降级的原因码。 */
  code?: string;
  /** 给人工看的核查信息。 */
  notes: string[];
  /** 结果不明、不得自动重放的动作。 */
  unresolved: UnresolvedAction[];
  /**
   * 存档里还有待人工确认的动作。有它就意味着"要不要改代码"这个决定还没做：
   * 在给出 --approve / --reject 之前，恢复入口不启动模型。
   */
  pendingApproval?: {
    actionId: string;
    toolName: string;
    stepId: string;
    patchHash: string;
    args: Record<string, unknown>;
  };
  /** 上次用的审批策略：续跑沿用同一套，避免出现"暂停前自动批准、恢复后卡审批"。 */
  autoApproved: boolean;
  /** 步骤当前状态摘要（保留原有进度）。 */
  steps: { stepId: string; status: string; attempts: number }[];
  checkpoint: CheckpointEnvelope;
}

export class ResumeRejected extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly inspection?: ResumeInspection,
  ) {
    super(message);
    this.name = "ResumeRejected";
  }
}

export interface InspectResumeInput {
  projectRoot: string;
  runId: string;
  /** pi 的会话存储；不传时自动打开落盘 journal。 */
  session?: Session;
  /** 落盘 journal 的会话 id（来自存档）。 */
  sessionId?: string;
  /** journal 所在的工作区根；默认等于 projectRoot。 */
  journalRoot?: string;
  lane?: string;
  /** 目标源码 + 相关测试文件，用于计算工作区摘要。 */
  digestFiles?: string[];
  /** 当前 runtime 的代码版本（用于比对）。 */
  currentRevision?: string;
}

/**
 * 只做检查，不还原、不执行。任何硬性条件不满足都抛 ResumeRejected。
 */
export async function inspectResumeState(
  input: InspectResumeInput,
): Promise<ResumeInspection> {
  // ① 校验存档（格式 / 版本 / 完整性）。
  const checkpoint = await loadCheckpoint(input.projectRoot, input.runId);
  const task = checkpoint.payload.task;

  // ② 校验工作区仍然存在。
  await assertWorkspaceExists(checkpoint.payload.workspace);

  // ③ 校验任务状态：终态运行不再续跑。
  if (isTerminalStatus(task.status)) {
    throw new ResumeRejected(
      "RUN_TERMINAL",
      `运行 ${input.runId} 已处于终态（${task.status}），不再续跑。`,
    );
  }

  const notes: string[] = [];
  const unresolved: UnresolvedAction[] = [];

  // 结果不明检测 1：存档里的代码版本 / 摘要与工作区不一致。
  // 典型场景 A2：补丁已写入，但下一份存档尚未保存。
  const digestFiles = input.digestFiles ?? [];
  if (digestFiles.length > 0) {
    const liveDigest = await computeRepoDigest(
      checkpoint.payload.workspace.repoRoot,
      digestFiles,
    );
    if (liveDigest !== checkpoint.payload.workspace.repoDigest) {
      notes.push(
        "工作区源码与存档摘要不一致：上次可能存在未存档的写入。",
      );
      unresolved.push({
        actionId: checkpoint.payload.workspace.codeRevision,
        toolName: "apply_patch",
        state: "unknown",
        reason: "代码摘要与存档不一致，结果不明，禁止自动重放写操作。",
      });
    }
  }

  // 结果不明检测 2：pi journal 中是否存在未闭合的操作（进程中断）。
  const journal = input.session ?? await openDurableJournal({
    checkpointRoot: input.journalRoot ?? input.projectRoot,
    sessionId: input.sessionId ?? checkpoint.payload.session.sessionId,
  }).catch(() => undefined);
  if (journal) {
    const lane = input.lane ?? "main";
    const open = await journal.findOpenOperations(lane, { limit: 2 });
    if (open.length > 1) {
      throw new ResumeRejected(
        "JOURNAL_CORRUPT",
        "会话中存在多个未闭合操作，无法安全判定恢复点。",
      );
    }
    if (open.length === 1) {
      notes.push(`检测到未闭合操作 ${open[0].id}（上次执行未正常结束）。`);
    }

    // 对未闭合操作下的 tool_started 逐一检查：写操作无完成记录 = 结果不明。
    const started = await journal.findRecords({
      lane,
      type: "tool_started",
      runId: open[0]?.id,
    });
    const finishedRecords = await journal.findRecords({
      lane,
      type: "operation_finished",
      runId: open[0]?.id,
    });
    if (started.length > 0 && finishedRecords.length === 0) {
      // journal 只记「工具启动」，判定"这次调用到底完成了没有"要看存档里的
      // 工具调用记录：R1 在启动时就落了记录，正常结束才会补 endedAt。
      // 少了这一步，早先回合里已经成功、只是同属这次未闭合操作的调用
      // 会被一并报成"结果不明"，人工核查信息就会被噪声淹没。
      const finishedCalls = new Set<string>();
      for (const step of task.steps) {
        for (const call of step.toolCalls) {
          if (call.endedAt !== undefined) finishedCalls.add(call.toolCallId);
        }
      }
      for (const record of started) {
        // replay:"safe" 的读操作允许重放；写操作一律 unknown。
        if (record.replay === "safe") continue;
        if (finishedCalls.has(record.toolCallId)) continue;
        unresolved.push({
          actionId: record.toolCallId,
          toolName: record.toolName,
          state: "unknown",
          reason: `工具 ${record.toolName} 已启动但无完成记录，结果不明。`,
        });
      }
    }
  }

  // 步骤级结果不明：启动过测试、但没有任何「完整结果」的验证步骤。
  // 注意：完整结果包括失败（exit=1）；失败是「结果明确且未通过」，
  // 不是「结果不明」。只有拿不到退出码（中断/启动后被杀）才属不明。
  for (const step of task.steps) {
    const testCalls = step.toolCalls.filter((call) => call.toolName === "run_test");
    if (testCalls.length === 0) continue;
    const hasCompleteResult = testCalls.some((call) => {
      const payload = (call.output?.evidence as { payload?: Record<string, unknown> } | undefined)
        ?.payload;
      return typeof payload?.exitCode === "number"
        || typeof payload?.passed === "boolean"
        || typeof call.output?.exitCode === "number";
    });
    if (!hasCompleteResult && step.status !== "completed") {
      unresolved.push({
        actionId: step.stepId,
        stepId: step.stepId,
        toolName: "run_test",
        state: "unknown",
        reason: "测试已启动但没有完整结果，不得记为通过。",
      });
      notes.push(`步骤 ${step.stepId}：测试缺少完整结果，需重新确认。`);
    }
  }

  const canResume = unresolved.length === 0;
  if (!canResume) {
    notes.push("存在结果不明的动作：已停止自动推进，请人工核查后再决定。");
  }

  return {
    runId: input.runId,
    canResume,
    code: canResume ? undefined : "RESULT_UNKNOWN",
    notes,
    unresolved,
    pendingApproval: task.pendingApproval
      ? {
        actionId: task.pendingApproval.actionId,
        toolName: task.pendingApproval.toolName,
        stepId: task.pendingApproval.stepId,
        patchHash: task.pendingApproval.patchHash,
        args: task.pendingApproval.args,
      }
      : undefined,
    autoApproved: task.decisions.some((item) => item.by === "auto"),
    steps: task.steps.map((step) => ({
      stepId: step.stepId,
      status: step.status,
      attempts: step.attempts,
    })),
    checkpoint,
  };
}

/**
 * 完整恢复入口：检查通过才还原并返回续跑所需的业务对象。
 * 检查不通过时抛 ResumeRejected，调用方不得启动模型或写工具。
 */
export async function prepareResume(input: InspectResumeInput): Promise<{
  inspection: ResumeInspection;
  task: TaskRecord;
  messages: CheckpointEnvelope["payload"]["session"]["messages"];
  plan: CheckpointEnvelope["payload"]["plan"];
  evidence: CheckpointEnvelope["payload"]["evidence"];
}> {
  const inspection = await inspectResumeState(input);
  if (!inspection.canResume) {
    throw new ResumeRejected(
      "RESULT_UNKNOWN",
      "上次动作结果不明，无法安全自动恢复。",
      inspection,
    );
  }
  const payload = inspection.checkpoint.payload;
  return {
    inspection,
    // 还原业务对象；计划/证据/计数原样保留，不重置。
    task: payload.task,
    messages: payload.session.messages,
    plan: payload.plan,
    evidence: payload.evidence,
  };
}

export { CheckpointError };
