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
  signal?: AbortSignal;
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
  input.signal?.throwIfAborted();
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
  const toolCallId = `approval-${approved.actionId}`;
  deps.recorder.beginToolCall({
    toolCallId,
    toolName: "apply_patch",
    args: approved.args,
    stepId: approved.stepId,
  });

  let committed: ManagedToolResult;
  try {
    await deps.approval.assertExecutable({
      actionId: input.actionId,
      repoRoot: deps.context.repoRoot,
    });
    input.signal?.throwIfAborted();
    committed = await deps.runtime.commitPatch({
      path: String(approved.args.path),
      search: String(approved.args.search),
      replace: String(approved.args.replace),
      context: deps.context,
      signal: input.signal,
      expectedPatchHash: approved.patchHash,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.recorder.endToolCall({ toolCallId, ok: false, failureReason: reason });
    // 本次授权已失效；保留具体补丁供人工核查，不跨取消/失败继承批准。
    deps.approval.restore(approved);
    deps.recorder.stageApproval({ ...approved, approved: false });
    deps.recorder.suspend(reason, approved.stepId);
    throw error;
  }

  let evidenceId: string | undefined;
  if (committed.ok && committed.evidence) {
    evidenceId = deps.session.addEvidence({
      stepId: approved.stepId,
      toolCallId,
      artifactVersion: deps.runtime.getRevision(),
      kind: committed.evidence.kind,
      summary: committed.evidence.summary,
      payload: committed.evidence.payload,
    }).id;
  }
  deps.recorder.endToolCall({
    toolCallId,
    ok: committed.ok,
    output: { code: committed.code, evidence: committed.evidence, result: committed.modelView },
    evidenceId,
    failureReason: committed.ok ? undefined : JSON.stringify(committed.modelView),
  });
  if (!committed.ok) {
    deps.approval.restore(approved);
    deps.recorder.stageApproval({ ...approved, approved: false });
    deps.recorder.suspend(committed.code, approved.stepId);
    return committed;
  }

  // 成功写入即保留真实进度；即使此刻取消，也不能把已落盘补丁说成回滚。
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
