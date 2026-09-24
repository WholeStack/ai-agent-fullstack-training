// ============================================================================
// LoopGuard：轮数、重复动作、完成契约与 Follow-up。
//
// 与 3.1 相比，本节把两件事接到 Loop 的既有 Hook 上：
//   beforeToolCall  —— 受计划约束的动作必须绑定到已就绪的步骤；
//   shouldStopAfterTurn —— 完成判断改为可注入的 CompletionContract。
// ============================================================================
import { createHash } from "node:crypto";
import type {
  AgentMessage,
  AfterToolCallContext,
  BeforeToolCallContext,
  ShouldStopAfterTurnContext,
} from "@earendil-works/pi-agent-core";

import type { CompletionContract, CompletionState } from "./completion-contract.js";
import { GOVERNED_TOOLS } from "./pi-tools.js";
import type { PlanningSession } from "./plan-store.js";
import type { ToolEvidence } from "./runtime.js";
import type { TaskRecorder } from "./task-record.js";

export interface Evidence {
  readFiles: Set<string>;
  writtenArtifacts: Set<string>;
}

export interface LoopState {
  runId: string;
  turn: number;
  maxTurns: number;
  stopCode?: string;
  /** 存档失败原因；非空表示本轮不允许静默推进。 */
  checkpointError?: string;
  actions: Map<string, number>;
  evidence: Evidence;
}

export interface LoopGuardDeps {
  session: PlanningSession;
  contract: CompletionContract;
  /** 当前代码版本，用于把证据绑定到产生它的版本。 */
  getRevision: () => string;
  getCompletionState?: () => Promise<CompletionState>;
  governedTools?: Set<string>;
  /** R1：任务/步骤记录器。 */
  recorder?: TaskRecorder;
  /** R2：每轮结束后的存档回调。 */
  onTurnCheckpoint?: () => Promise<void>;
  /** R4：待审批时中断本轮自动推进。 */
  isAwaitingApproval?: () => boolean;
  /** journal：工具启动回调。 */
  onToolStart?: (info: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  }) => Promise<void>;
  /** 测试用崩溃点：在指定工具启动后强制退出。 */
  crashOnToolStart?: string;
}

export class LoopGuard {
  private followUps: AgentMessage[] = [];
  private readonly governedTools: Set<string>;

  constructor(
    readonly state: LoopState,
    private readonly deps: LoopGuardDeps,
  ) {
    this.governedTools = deps.governedTools ?? GOVERNED_TOOLS;
  }

  async beforeToolCall(
    context: BeforeToolCallContext,
  ): Promise<{ block?: boolean; reason?: string }> {
    const fingerprint = this.fingerprint(context.toolCall.name, context.args);
    const count = this.state.actions.get(fingerprint) ?? 0;
    this.state.actions.set(fingerprint, count + 1);

    if (count + 1 >= 3) {
      this.state.stopCode = "REPEATED_ACTION";
      // 重复动作是「暂停」，不是失败：保留已有记录与预算。
      this.deps.recorder?.suspend("REPEATED_ACTION");
      return {
        block: true,
        reason: [
          "REPEATED_ACTION：相同工具和参数已出现三次。",
          "本次调用未执行。",
        ].join(" "),
      };
    }

    // R4：等待审批期间，其它需要审批的写操作也不能绕过检查。
    // 解除等待的入口是人工决定（--approve/--reject）或显式的 --auto-approve，
    // 都不是模型能自己发的工具调用。
    if (this.deps.isAwaitingApproval?.()) {
      this.state.stopCode = "WAITING_APPROVAL";
      return {
        block: true,
        reason: "WAITING_APPROVAL：存在待审批动作，本轮自动推进已暂停。",
      };
    }

    const gate = this.checkPlanGate(context);
    if (gate.block) return gate;

    // R1：工具开始前先落记录；中断时才能判定「结果不明」。
    const args = (context.args ?? {}) as Record<string, unknown>;
    this.deps.recorder?.beginToolCall({
      toolCallId: context.toolCall.id,
      toolName: context.toolCall.name,
      args,
      stepId: typeof args.planStepId === "string" ? args.planStepId : undefined,
    });

    // journal：记录工具启动；在崩溃点之前写完，确保重启后可见。
    if (this.deps.onToolStart) {
      await this.deps.onToolStart({
        toolCallId: context.toolCall.id,
        toolName: context.toolCall.name,
        args,
      });
    }

    // 测试用崩溃点：工具已登记为「已启动」，但结果永远拿不到（A3）。
    if (this.deps.crashOnToolStart === context.toolCall.name) {
      process.exit(137);
    }

    return {};
  }

  /** 受计划约束的动作必须绑定步骤，且该步骤当前允许执行。 */
  private checkPlanGate(
    context: BeforeToolCallContext,
  ): { block?: boolean; reason?: string } {
    const plan = this.deps.session.plan;
    if (!plan) return {};

    const args = context.args as Record<string, unknown>;
    const stepId = args.planStepId;
    if (typeof stepId !== "string" || stepId.length === 0) {
      // 读类工具可以不带步骤，但写入、改代码和跑测试必须绑定计划步骤。
      if (!this.governedTools.has(context.toolCall.name)) return {};
      return {
        block: true,
        reason: [
          "PLAN_STEP_REQUIRED：计划已创建，写入、改代码和跑测试必须携带 planStepId。",
          `当前就绪步骤：${plan.readySteps().map((step) => step.id).join(",") || "无"}。`,
        ].join(" "),
      };
    }

    try {
      plan.ensureActive(stepId);
    } catch (error) {
      return {
        block: true,
        reason: [
          "PLAN_STEP_NOT_READY：本次调用未执行。",
          error instanceof Error ? error.message : String(error),
        ].join(" "),
      };
    }

    return {};
  }

  observeToolResult(context: AfterToolCallContext): void {
    const args = (context.args ?? {}) as Record<string, unknown>;
    const stepId = typeof args.planStepId === "string" ? args.planStepId : undefined;

    // R1：无论成功失败都先落一条记录；失败要保留失败原因。
    this.deps.recorder?.endToolCall({
      toolCallId: context.toolCall.id,
      ok: !context.isError,
      output: context.result.details as Record<string, unknown> | undefined,
      failureReason: context.isError
        ? extractFailureReason(context.result)
        : undefined,
    });

    // 计划工具的 complete/fail 也要镜像到步骤记录里。
    if (context.toolCall.name === "update_plan_step") {
      this.mirrorPlanProgress();
    }


    if (!context.isError && context.toolCall.name === "read_file" && typeof args.path === "string") {
      this.state.evidence.readFiles.add(args.path);
    }
    if (!context.isError && context.toolCall.name === "write_file" && typeof args.path === "string") {
      this.state.evidence.writtenArtifacts.add(args.path);
    }

    // 工具 ok:true 但测试未通过：这是一次失败的验证，必须计入失败记录，
    // 且绝不能被当作通过（R1：工具成功 ≠ 测试通过）。
    if (
      context.toolCall.name === "run_test"
      && typeof stepId === "string"
      && (context.result.details as { evidence?: { payload?: { passed?: boolean } } })
        ?.evidence?.payload?.passed === false
    ) {
      const scope = (context.result.details as { evidence?: { payload?: { scope?: string } } })
        ?.evidence?.payload?.scope ?? "unknown";
      this.deps.recorder?.recordTestFailure(stepId, `测试未通过：${scope}`);
    }

    // Runtime 产出的证据草稿，由计划层补全工具调用 ID 与代码版本。
    const details = context.result.details as
      | { evidence?: ToolEvidence }
      | undefined;
    const draft = details?.evidence;
    if (!draft || typeof stepId !== "string") return;
    if (context.isError && draft.kind !== "test") return;

    const evidence = this.deps.session.addEvidence({
      stepId,
      toolCallId: context.toolCall.id,
      artifactVersion: typeof draft.payload.revision === "string"
        ? draft.payload.revision
        : this.deps.getRevision(),
      kind: draft.kind,
      summary: draft.summary,
      payload: draft.payload,
    });
    this.deps.recorder?.attachEvidence(context.toolCall.id, evidence.id);
  }

  /**
   * R1：把计划层的状态变化同步进任务记录。
   * 计划层仍然是唯一裁决者；这里只是把「已经发生的状态」镜像到记录里。
   */
  private mirrorPlanProgress(): void {
    const plan = this.deps.session.plan;
    if (!plan) return;
    for (const step of plan.snapshot().steps) {
      const record = this.deps.recorder?.step(step.id);
      if (!record) continue;
      if (step.status === "completed" && record.status !== "completed") {
        this.deps.recorder?.completeStep(step.id, step.evidenceIds);
      } else if (step.status === "failed") {
        this.deps.recorder?.failStep(
          step.id,
          step.lastError ?? "计划步骤失败",
          "retry",
        );
      }
    }
  }

  async afterTurn(context: ShouldStopAfterTurnContext): Promise<boolean> {
    if (this.state.stopCode) {
      // 暂停不是失败。INTERRUPTED 不改变任务状态：人工暂停只是停下来，
      // 任务仍在 running，恢复时直接续跑，不会落进"结果不明"。
      return true;
    }

    if (this.state.turn >= this.state.maxTurns) {
      this.state.stopCode = "MAX_TURNS_EXCEEDED";
      return true;
    }

    if (context.toolResults.length === 0) {
      // 没有 Tool Call 只是协议层停止；业务层仍要验证交付证据。
      const missing = await this.verifyCompletion();
      if (missing.length === 0) {
        this.state.stopCode = "COMPLETED";
        return true;
      }

      this.followUps.push({
        role: "user",
        content: [{
          type: "text",
          text: [
            "FINAL_REJECTED：完成证据不足。",
            ...missing.map((item) => `- ${item}`),
            "请继续使用工具补齐证据和交付物，不要只给出文字说明。",
          ].join("\n"),
        }],
        timestamp: Date.now(),
      });
    }

    return false;
  }

  drainFollowUps(): AgentMessage[] {
    return this.followUps.splice(0);
  }

  async verifyCompletion(): Promise<string[]> {
    let current: CompletionState | undefined;
    try {
      current = await this.deps.getCompletionState?.();
    } catch (error) {
      return [`无法核对完成现场：${error instanceof Error ? error.message : String(error)}；请修复后重新验证`];
    }
    return this.deps.contract.verify({
      plan: this.deps.session.snapshot(),
      evidence: this.deps.session.evidence.list(),
      revision: this.deps.getRevision(),
      current,
    });
  }

  private fingerprint(name: string, args: unknown): string {
    return createHash("sha256")
      .update(JSON.stringify(this.sortValue({ name, args })))
      .digest("hex");
  }

  private sortValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.sortValue(item));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, this.sortValue(item)]),
      );
    }
    return value;
  }
}

/** 从 Tool Result 中提取失败原因，供 R1 记录。 */
function extractFailureReason(result: { content?: unknown }): string {
  const content = result.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string" && text.length > 0) {
        return text.slice(0, 300);
      }
    }
  }
  return "UNKNOWN_TOOL_FAILURE";
}
