// ============================================================================
// 3.3 R4 执行段：批准 → 执行前重算 patchHash → 落盘 → 补证据 → 清空待审批。
//
// 两条入口共用这一段，审批语义一字不改：
//   --auto-approve  机器当场放行，decisions 记 by:"auto"；
//   人工入口        --approve / --reject，decisions 记 by:"manual"。
// 模型不能批准自己提交的补丁：批准只从这个模块的两个入口进来，
// 一个来自人工决定，一个来自显式声明的自动批准开关。
// ============================================================================

import type { ApprovalGate } from "./approval.js";
import type { PlanningSession } from "./plan-store.js";
import type { DemoExecutionContext } from "./run-context.js";
import type { DemoToolRuntime, ManagedToolResult } from "./runtime.js";
import type { TaskRecorder } from "./task-record.js";

export interface ApprovalFlowDeps {
  approval: ApprovalGate;
  runtime: DemoToolRuntime;
  session: PlanningSession;
  recorder: TaskRecorder;
  context: DemoExecutionContext;
}

export interface ApprovalDecisionInput {
  actionId: string;
  /** 决定来源：manual = 真人入口，auto = --auto-approve。 */
  by: "manual" | "auto";
  reason?: string;
  /** 落盘之后的回拨；测试用它制造"补丁已写、存档未写"的崩溃点。 */
  onAfterCommit?: () => Promise<void>;
}

/**
 * 批准并落盘一个待审批补丁。
 * assertExecutable 会重新计算 patchHash：补丁参数或目标文件内容变化
 * 都会让旧授权作废（APPROVAL_STALE），此时源码保持不变。
 */
export async function applyApprovedPatch(
  deps: ApprovalFlowDeps,
  input: ApprovalDecisionInput,
): Promise<ManagedToolResult> {
  const approved = deps.approval.approve(input.actionId, input.reason);
  deps.recorder.recordDecision({
    actionId: input.actionId,
    decision: "approved",
    patchHash: approved.patchHash,
    by: input.by,
    reason: input.reason,
    decidedAt: Date.now(),
  });
  deps.recorder.transition(
    "approval_granted",
    "running",
    input.by === "auto" ? "approved automatically" : "approved by operator",
  );

  await deps.approval.assertExecutable({
    actionId: input.actionId,
    repoRoot: deps.context.repoRoot,
  });

  const committed = await deps.runtime.commitPatch({
    path: String(approved.args.path),
    search: String(approved.args.search),
    replace: String(approved.args.replace),
    context: deps.context,
  });

  // 落盘成功时由审批入口代表该写操作补上证据与记录，
  // 使该步骤仍能通过 PlanStore 的证据规则完成。
  if (committed.ok && committed.evidence) {
    const evidence = deps.session.addEvidence({
      stepId: approved.stepId,
      toolCallId: approved.actionId,
      artifactVersion: deps.runtime.getRevision(),
      kind: committed.evidence.kind,
      summary: committed.evidence.summary,
      payload: committed.evidence.payload,
    });
    deps.recorder.endToolCall({
      toolCallId: `approval-${approved.actionId}`,
      ok: true,
      output: committed.modelView as Record<string, unknown>,
      evidenceId: evidence.id,
    });
    // 不在这里把步骤记为 completed：完成只能由计划层的证据规则裁决，
    // 审批入口只负责让这次写操作留下可引用的证据。
  } else {
    deps.recorder.endToolCall({
      toolCallId: `approval-${approved.actionId}`,
      ok: false,
      failureReason: "补丁落盘失败",
    });
  }

  deps.approval.complete(input.actionId);
  deps.recorder.clearApproval();
  await input.onAfterCommit?.();
  return committed;
}

/**
 * 拒绝一个待审批补丁。拒绝后该补丁不会执行，运行停在 suspended：
 * 这是人工做出的决定，不是任务失败，也不是"结果不明"。
 */
export function rejectPendingPatch(
  deps: ApprovalFlowDeps,
  input: { actionId: string; by: "manual" | "auto"; reason?: string },
): void {
  const rejected = deps.approval.reject(input.actionId, input.reason);
  deps.recorder.recordDecision({
    actionId: input.actionId,
    decision: "rejected",
    patchHash: rejected.patchHash,
    by: input.by,
    reason: input.reason,
    decidedAt: Date.now(),
  });
  deps.recorder.failStep(
    rejected.stepId,
    `补丁被拒绝：${input.reason ?? "未给出理由"}`,
    "abort",
  );
  // 计划层同样记一次失败：被拒绝的修复尝试不算数，要换方案就得走修订或重试，
  // 否则"步骤还在进行中"会被误读成"补丁可能已经生效"。
  deps.session.plan?.fail(rejected.stepId, `补丁被拒绝：${input.reason ?? "未给出理由"}`);
  deps.recorder.setStopCode("APPROVAL_REJECTED");
  deps.recorder.transition(
    "approval_rejected",
    "suspended",
    input.by === "auto" ? "rejected automatically" : "rejected by operator",
  );
  deps.recorder.clearApproval();
}
