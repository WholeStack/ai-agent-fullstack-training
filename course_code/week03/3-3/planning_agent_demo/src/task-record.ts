// ============================================================================
// 3.3 R1：任务与步骤记录
//
// 记录的是「实际发生了什么」，而不是「模型说发生了什么」：
//   工具调用 ID、输入、输出、失败原因、重试记录、下一步决策、完成证据。
//
// 关键语义（与 R1 逐条对应）：
//   1. 暂停（suspended）与等待审批（waiting_approval）不是失败；
//   2. 工具返回成功（ok:true）不等于步骤完成，更不等于任务完成；
//      「完成」只能由证据 + 测试退出码决定，记在 StepRecord 上；
//   3. 已完成、失败或取消的运行不再续跑（isTerminal）。
//
// 运行状态是一台显式状态机：每次迁移都写进 transitions，
// 因此「为什么停在这里、恢复后接着谁」可以被人工逐条核对，
// 而不是只能看到最后一个状态码。
//
// 本文件不碰 pi 的 Hook，由 LoopGuard / 审批层调用它更新记录。
// ============================================================================

/** 一次运行的整体状态。 */
export type RunStatus =
  | "running"              // 正在执行
  | "waiting_tool"         // 已发出工具调用，等待其返回
  | "waiting_approval"     // 等待人工审批（不是失败）
  | "suspended"            // 暂停（预算/重复/结果不明，不是失败）
  | "completed"            // 完成契约通过
  | "failed"               // 失败
  | "cancelled";           // 人工取消

/**
 * 一个步骤的运行状态。
 * 注意：等待审批是「任务」在等，不是步骤被卡住——步骤仍是 in_progress，
 * 只在 nextDecision 上标 await_approval。这样批准之后不需要额外还原步骤状态。
 */
export type StepRunStatus =
  | "pending"
  | "in_progress"
  | "suspended"            // 暂停（不是失败）
  | "completed"
  | "failed";

/** 状态机的一条迁移记录。 */
export interface StateTransition {
  /** 全局序号，跨进程延续：恢复后的第一条接着上一份存档继续编号。 */
  seq: number;
  at: number;
  from: RunStatus;
  /** 触发事件，如 tool_started / approval_granted / task_resumed / task_completed。 */
  event: string;
  to: RunStatus;
  detail?: string;
}

/** 步骤的下一步决策：恢复时据此决定是否允许继续。 */
export type NextDecision =
  | "continue"             // 可以继续后续步骤
  | "await_approval"       // 等待人工决定
  | "retry"                // 允许重试
  | "recheck"              // 结果不明，需要人工核查
  | "abort";               // 停止自动推进

/** 单次工具调用的记录。包含 R1 要求的全部字段。 */
export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  /** 执行输入（脱敏后的参数）。 */
  input: Record<string, unknown>;
  /** 执行输出：成功为模型可见摘要，失败为错误码。 */
  output?: Record<string, unknown>;
  /** 由工具自身产生的证据 ID（若该工具产出证据）。 */
  evidenceIds: string[];
  /** 失败原因（成功时为空）。 */
  failureReason?: string;
  /** 该工具名在本步骤内的第几次尝试。 */
  attempt: number;
  ok: boolean;
  startedAt: number;
  endedAt?: number;
}

/** 步骤运行记录：计划状态之外，额外保留执行过程与决策。 */
export interface StepRecord {
  stepId: string;
  status: StepRunStatus;
  /** 该步骤被尝试执行的次数（重试记录）。 */
  attempts: number;
  toolCalls: ToolCallRecord[];
  /** 累积的失败原因，保留历史，不在恢复时清空。 */
  failures: string[];
  /** 完成证据 ID（只有证据齐全时才写入）。 */
  evidenceIds: string[];
  nextDecision: NextDecision;
  /** 给人工看的核查信息（结果不明时）。 */
  inspection?: string;
}

/** 运行计数与预算消耗；恢复时必须原样保留，不得重置。 */
export interface RunCounters {
  turn: number;
  maxTurns: number;
  /** 已消耗的工具调用次数（预算）。 */
  toolCalls: number;
  maxToolCalls: number;
  /** 计划修订次数，恢复时保留。 */
  revisions: number;
  maxRevisions: number;
  /**
   * 已写出的存档份数，也就是「存档序号」。
   * 跨进程延续：恢复后写入的第一份存档接着上一份编号，不重置为 1。
   */
  checkpoints: number;
}

/** 运行记录本体，也是存档的业务对象部分。 */
export interface TaskRecord {
  runId: string;
  /** 原任务输入，R5 重跑时复用它。 */
  taskInput: string;
  status: RunStatus;
  stopCode?: string;
  steps: StepRecord[];
  counters: RunCounters;
  /** 待审批动作（R4）；同一时刻最多一个。 */
  pendingApproval?: PendingApproval;
  /** 人工决定的历史：批准/拒绝都会留下记录。 */
  decisions: HumanDecision[];
  /** 状态机迁移历史：跨进程累积，恢复后接着编号继续写。 */
  transitions: StateTransition[];
  /**
   * 人工决定的来源：manual 为真人入口，auto 为 --auto-approve。
   * 审批实验必须能区分「机器放行」与「人批准」，否则同一份记录无法复用。
   */
  decisionsBy: { manual: number; auto: number };
  /**
   * 恢复标记：运行是否由另一个进程从存档检查并续跑而来。
   * 用于暂停实验的第二次运行——脚本从后续步骤继续，而不是重做整条链路。
   */
  resumedFromCheckpoint?: boolean;
  startedAt: number;
  updatedAt: number;
}

/** R4：等待人工审批的具体动作。 */
export interface PendingApproval {
  actionId: string;
  toolName: string;
  /** 动作参数（apply_patch 的 path/search/replace）。 */
  args: Record<string, unknown>;
  /** 参数与目标文件内容一起算出的哈希；参数或文件变化都会使其失效。 */
  patchHash: string;
  stepId: string;
  /**
   * 是否已批准。进程重启后一定会是 false：
   * 审批状态只存在于内存，重启后从存档读回也强制为 false。
   */
  approved: boolean;
  stagedAt: number;
}

export interface HumanDecision {
  actionId: string;
  decision: "approved" | "rejected";
  /** 作出决定时的 patchHash；用于执行前比对。 */
  patchHash: string;
  /** 决定来源：manual = 真人入口，auto = --auto-approve。 */
  by?: "manual" | "auto";
  reason?: string;
  decidedAt: number;
}

/** 停止码 → 收尾状态。未列出的停止码按失败处理，宁可显式失败也不静默通过。 */
const STOP_CODE_STATUS: Record<string, RunStatus> = {
  COMPLETED: "completed",
  WAITING_APPROVAL: "waiting_approval",
  APPROVAL_REJECTED: "suspended",
  RESULT_UNKNOWN: "suspended",
  REPEATED_ACTION: "suspended",
  MAX_TURNS_EXCEEDED: "suspended",
  MODEL_ERROR: "suspended",
  // INTERRUPTED 不在此表：人工暂停不改变任务状态，任务仍在 running。
};

/** 终态：不再续跑。等待审批与暂停都不在其列。 */
export function isTerminalStatus(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * 任务记录器：唯一允许修改 TaskRecord 的入口。
 * 它不做业务判断（是否完成由 PlanStore / CompletionContract 决定），
 * 只忠实记录事件与状态迁移。
 */
export class TaskRecorder {
  private readonly record: TaskRecord;
  private readonly stepIndex = new Map<string, StepRecord>();
  private readonly toolIndex = new Map<string, ToolCallRecord>();

  constructor(input: {
    runId: string;
    taskInput: string;
    steps: string[];
    counters: RunCounters;
    now?: number;
  }) {
    const now = input.now ?? Date.now();
    this.record = {
      runId: input.runId,
      taskInput: input.taskInput,
      status: "running",
      steps: input.steps.map((stepId) => this.newStep(stepId)),
      counters: { ...input.counters },
      decisions: [],
      decisionsBy: { manual: 0, auto: 0 },
      transitions: [],
      startedAt: now,
      updatedAt: now,
    };
    for (const step of this.record.steps) {
      this.stepIndex.set(step.stepId, step);
    }
    this.transition("task_started", "running");
  }

  /** 从已有记录重建（恢复流程使用）。 */
  static restore(record: TaskRecord): TaskRecorder {
    const recorder = Object.create(TaskRecorder.prototype) as TaskRecorder;
    // 恢复时强制清空审批通过标记：不能被进程重启"继承"为已批准。
    const restored = structuredClone(record);
    if (restored.pendingApproval) {
      restored.pendingApproval.approved = false;
    }
    // 兼容 3.3 早期存档：缺 decisionsBy 时按历史决定补算，不重置为 0。
    if (!restored.decisionsBy) {
      restored.decisionsBy = {
        manual: restored.decisions.filter((item) => (item.by ?? "manual") === "manual").length,
        auto: restored.decisions.filter((item) => item.by === "auto").length,
      };
    }
    restored.transitions ??= [];
    // 本次运行是"检查存档后续跑"，用于暂停实验区分首次运行与恢复运行。
    restored.resumedFromCheckpoint = true;
    Object.assign(recorder, {
      record: restored,
      stepIndex: new Map(restored.steps.map((step) => [step.stepId, step])),
      toolIndex: new Map(
        restored.steps
          .flatMap((step) => step.toolCalls)
          .map((call) => [call.toolCallId, call]),
      ),
    });
    return recorder;
  }

  snapshot(): TaskRecord {
    return structuredClone(this.record);
  }

  get status(): RunStatus {
    return this.record.status;
  }

  get runId(): string {
    return this.record.runId;
  }

  get counters(): RunCounters {
    return this.record.counters;
  }

  get pendingApproval(): PendingApproval | undefined {
    return this.record.pendingApproval
      ? structuredClone(this.record.pendingApproval)
      : undefined;
  }

  step(stepId: string): StepRecord {
    const step = this.stepIndex.get(stepId);
    if (!step) {
      // 计划修订可能引入新步骤；记录层按需扩展，不因此失败。
      const created = this.newStep(stepId);
      this.record.steps.push(created);
      this.stepIndex.set(stepId, created);
      return created;
    }
    return step;
  }

  /**
   * 记录一次状态迁移。from 取当前状态，允许自环
   * （例如 running -(task_interrupted)-> running），自环本身就是一条事实记录。
   */
  transition(event: string, to: RunStatus = this.record.status, detail?: string): void {
    this.record.transitions.push({
      seq: this.record.transitions.length + 1,
      at: Date.now(),
      from: this.record.status,
      event,
      to,
      detail,
    });
    this.record.status = to;
    this.touch();
  }

  setStopCode(stopCode?: string): void {
    this.record.stopCode = stopCode;
    this.touch();
  }

  /** 写出下一份存档前调用：返回本次的存档序号（跨进程延续）。 */
  countCheckpoint(): number {
    this.record.counters.checkpoints += 1;
    this.touch();
    return this.record.counters.checkpoints;
  }

  /**
   * 运行收尾：把停止码落成状态机的收尾状态。
   * INTERRUPTED 是唯一不改变状态的停止码——人工暂停只是停下来，
   * 任务本身没有失败、也没有进入任何等待，仍然可以续跑。
   */
  finish(stopCode?: string): RunStatus {
    this.record.stopCode = stopCode;
    const target = stopCode ? STOP_CODE_STATUS[stopCode] : undefined;
    if (!target) {
      this.touch();
      return this.record.status;
    }
    if (target !== this.record.status) {
      const event = stopCode === "COMPLETED"
        ? "task_completed"
        : target === "cancelled"
          ? "task_cancelled"
          : "task_suspended";
      this.transition(event, target, stopCode);
      return this.record.status;
    }
    this.touch();
    return this.record.status;
  }

  /** 运行/步骤进入暂停：不是失败。 */
  suspend(reason: string, stepId?: string): void {
    if (stepId) {
      const step = this.step(stepId);
      step.status = "suspended";
      step.nextDecision = "recheck";
      step.inspection = reason;
    }
    this.transition("task_suspended", "suspended", reason);
    this.record.stopCode = reason;
    this.touch();
  }

  /** 轮次推进，同时计入预算。 */
  advanceTurn(): void {
    this.record.counters.turn += 1;
    this.touch();
  }

  /** 消耗一次工具调用预算。 */
  consumeToolBudget(): void {
    this.record.counters.toolCalls += 1;
    this.touch();
  }

  /** 工具开始：先落记录，失败/中断时才能判定"结果不明"。 */
  beginToolCall(input: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    stepId?: string;
    now?: number;
  }): void {
    const call: ToolCallRecord = {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      input: sanitize(input.args),
      evidenceIds: [],
      attempt: 1,
      ok: false,
      startedAt: input.now ?? Date.now(),
    };
    if (input.stepId) {
      const step = this.step(input.stepId);
      call.attempt = step.attempts + 1;
      step.toolCalls.push(call);
      step.status = "in_progress";
    } else {
      // 未绑定步骤的调用（读类），单独挂在 __unbound__ 下。
      this.step("__unbound__").toolCalls.push(call);
    }
    this.toolIndex.set(call.toolCallId, call);
    this.consumeToolBudget();
    this.transition("tool_started", "waiting_tool", input.toolName);
  }

  /** 工具结束：记录输出或失败原因。ok:true 不代表步骤完成。 */
  endToolCall(input: {
    toolCallId: string;
    ok: boolean;
    output?: Record<string, unknown>;
    evidenceId?: string;
    failureReason?: string;
    now?: number;
  }): void {
    const call = this.toolIndex.get(input.toolCallId);
    if (!call) return;
    call.ok = input.ok;
    call.output = input.output ? sanitize(input.output) : undefined;
    call.failureReason = input.failureReason;
    if (input.evidenceId) call.evidenceIds.push(input.evidenceId);
    call.endedAt = input.now ?? Date.now();

    const step = this.findStepByCall(input.toolCallId);
    if (step && !input.ok) {
      // 失败原因累积保留，重试不清空历史。
      step.failures.push(input.failureReason ?? "UNKNOWN_TOOL_FAILURE");
      step.attempts += 1;
    }
    const detail = typeof call.output?.code === "string"
      ? call.output.code
      : input.failureReason;
    // 只有确实是本次等待的返回才回到 running：等待审批期间结束一个工具调用，
    // 不代表审批已经结束，任务仍停在 waiting_approval。
    this.transition(
      input.ok ? "tool_succeeded" : "tool_failed",
      this.record.status === "waiting_tool" ? "running" : this.record.status,
      detail,
    );
  }

  /** 绑定工具调用产生的证据。 */
  attachEvidence(toolCallId: string, evidenceId: string): void {
    const call = this.toolIndex.get(toolCallId);
    if (call && !call.evidenceIds.includes(evidenceId)) {
      call.evidenceIds.push(evidenceId);
    }
    this.touch();
  }

  /** 步骤完成：只有证据与验收都通过时调用方才会走到这里。 */
  completeStep(stepId: string, evidenceIds: string[]): void {
    const step = this.step(stepId);
    step.status = "completed";
    step.evidenceIds.push(...evidenceIds);
    step.nextDecision = "continue";
    this.touch();
  }

  /** 步骤失败：记录原因并给出重试/停止决策。 */
  failStep(stepId: string, reason: string, decision: NextDecision = "retry"): void {
    const step = this.step(stepId);
    step.status = "failed";
    step.failures.push(reason);
    step.nextDecision = decision;
    this.touch();
  }

  /**
   * 可重试的验证失败：累计失败原因与尝试次数，但不把步骤置为 failed。
   * 用于「工具返回 ok:true，但测试未通过」：既不算通过，也不终止步骤。
   */
  recordTestFailure(stepId: string, reason: string): void {
    const step = this.step(stepId);
    step.failures.push(reason);
    step.attempts += 1;
    step.nextDecision = "retry";
    this.touch();
  }

  /** R4：暂存待审批动作，并把运行切到等待审批（不是失败）。 */
  stageApproval(approval: PendingApproval, detail?: string): void {
    this.record.pendingApproval = { ...approval, approved: false };
    const step = this.step(approval.stepId);
    // 步骤保持 in_progress：等审批的是任务，不是这一步被卡住。
    step.nextDecision = "await_approval";
    this.record.stopCode = "WAITING_APPROVAL";
    this.transition(
      "approval_requested",
      "waiting_approval",
      detail ?? `apply_patch@${approval.actionId}`,
    );
  }

  /** R4：记录人工决定；批准只对对应 actionId 生效。 */
  recordDecision(decision: HumanDecision): void {
    // by 缺省视为 manual：真人入口是既有语义，auto 必须显式声明。
    const by = decision.by ?? "manual";
    this.record.decisions.push({ ...decision, by });
    this.record.decisionsBy[by] += 1;
    if (this.record.pendingApproval?.actionId === decision.actionId) {
      this.record.pendingApproval.approved = decision.decision === "approved";
    }
    this.touch();
  }

  /**
   * R4：清空待审批动作。只做清理，状态迁移由调用方显式记录——
   * 批准回到 running，拒绝停在 suspended，两者不能混为一谈。
   */
  clearApproval(): void {
    this.record.pendingApproval = undefined;
    this.touch();
  }

  private findStepByCall(toolCallId: string): StepRecord | undefined {
    for (const step of this.record.steps) {
      if (step.toolCalls.some((call) => call.toolCallId === toolCallId)) {
        return step;
      }
    }
    return undefined;
  }

  private newStep(stepId: string): StepRecord {
    return {
      stepId,
      status: "pending",
      attempts: 0,
      toolCalls: [],
      failures: [],
      evidenceIds: [],
      nextDecision: "continue",
    };
  }

  private touch(): void {
    this.record.updatedAt = Date.now();
  }
}

/** 输入输出只保留可序列化的浅层内容；大文本截断，避免存档膨胀。 */
function sanitize(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      output[key] = item.length > 500 ? `${item.slice(0, 500)}…[truncated]` : item;
    } else if (
      item === null
      || typeof item === "number"
      || typeof item === "boolean"
    ) {
      output[key] = item;
    } else if (Array.isArray(item)) {
      output[key] = item.slice(0, 20);
    } else if (item && typeof item === "object") {
      output[key] = sanitize(item as Record<string, unknown>);
    }
  }
  return output;
}
