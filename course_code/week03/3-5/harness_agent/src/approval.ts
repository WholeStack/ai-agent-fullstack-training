// ============================================================================
// 3.3 R4：人工审批
//
// 修改源码前先把「具体补丁」保存下来，进入 waiting_approval 状态，
// 此时不执行任何写入。规则：
//   1. 批准前不能执行；拒绝后不能执行（且不能因为重新 stage 绕过拒绝）；
//   2. 等待期间其他需要审批的写操作也不能绕过检查（同一时刻只允许一个待审批）；
//   3. 批准只适用于对应 actionId；
//   4. 补丁参数或相关文件内容变化后，patchHash 变化 → 旧授权作废，重新审批；
//   5. 进程重启不默认获得批准（approved 由内存决定，存档只存动作本身）。
// ============================================================================

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { PendingApproval } from "./task-record.js";

export class ApprovalError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ApprovalError";
  }
}

/** 补丁内容：参数 + 目标文件当时的全文摘要。 */
export interface PatchPlan {
  readonly path: string;
  readonly search: string;
  readonly replace: string;
  /** 替换片段在文件中的出现次数；必须为 1 才允许执行。 */
  readonly occurrences: number;
  readonly patchHash: string;
}

export class ApprovalGate {
  private pending?: PendingApproval;
  private readonly decided = new Map<string, "approved" | "rejected">();
  private sequence = 0;

  /**
   * 计算补丁计划。只读文件、只算 hash，不写任何内容。
   * patchHash 覆盖 path + search + replace + 文件当前内容，
   * 因此"参数变了"或"文件变了"都会改变 hash。
   */
  async planPatch(input: {
    repoRoot: string;
    relativePath: string;
    search: string;
    replace: string;
  }): Promise<PatchPlan> {
    const absolute = path.join(input.repoRoot, input.relativePath);
    let content: string;
    try {
      content = await readFile(absolute, "utf8");
    } catch {
      throw new ApprovalError("PATCH_FILE_NOT_FOUND", `目标文件不存在：${input.relativePath}`);
    }

    const occurrences = content.split(input.search).length - 1;
    const patchHash = createHash("sha256")
      .update(
        [
          input.relativePath,
          input.search,
          input.replace,
          createHash("sha256").update(content).digest("hex"),
        ].join("\u0000"),
      )
      .digest("hex");

    return {
      path: input.relativePath,
      search: input.search,
      replace: input.replace,
      occurrences,
      patchHash,
    };
  }

  /**
   * 暂存一个待审批动作。等待期间不允许再排队第二个待审批动作
   * （防止其他写操作绕过检查）。
   */
  stage(input: {
    plan: PatchPlan;
    stepId: string;
    toolName?: string;
    now?: number;
  }): PendingApproval {
    if (this.pending) {
      throw new ApprovalError(
        "APPROVAL_ALREADY_PENDING",
        `已有待审批动作 ${this.pending.actionId}，必须先批准或拒绝`,
      );
    }
    const actionId = `act-${++this.sequence}`;
    this.pending = {
      actionId,
      toolName: input.toolName ?? "apply_patch",
      args: {
        path: input.plan.path,
        search: input.plan.search,
        replace: input.plan.replace,
      },
      patchHash: input.plan.patchHash,
      stepId: input.stepId,
      approved: false,
      stagedAt: input.now ?? Date.now(),
    };
    return { ...this.pending };
  }

  peek(): PendingApproval | undefined {
    return this.pending ? { ...this.pending } : undefined;
  }

  /**
   * 从存档还原一个待审批动作。
   * 批准标记一定被强制清成 false：审批只存在于做出决定的那个进程，
   * 重启后必须由人工重新决定，不能因为"上次已经点过批准"就放行。
   */
  restore(pending: PendingApproval): void {
    const actionId = pending.actionId;
    this.pending = { ...structuredClone(pending), approved: false };
    this.decided.delete(actionId);
    // 续跑时继续发号，避免新动作与还原回来的 actionId 撞号。
    const matched = /^act-(\d+)$/.exec(actionId);
    if (matched) this.sequence = Math.max(this.sequence, Number(matched[1]));
  }

  /**
   * 批准某个 actionId。批准只对该动作生效；其他 actionId 直接拒绝。
   * 注意：这里只记决定，不执行——执行入口仍会重新校验。
   */
  approve(actionId: string, reason?: string): PendingApproval {
    const pending = this.requirePending(actionId);
    pending.approved = true;
    this.decided.set(actionId, "approved");
    return { ...pending, ...(reason ? {} : {}) };
  }

  /** 拒绝某个 actionId；拒绝后该动作不可执行。 */
  reject(actionId: string, reason?: string): PendingApproval {
    const pending = this.requirePending(actionId);
    pending.approved = false;
    this.decided.set(actionId, "rejected");
    const snapshot = { ...pending };
    this.pending = undefined;
    return { ...snapshot, ...(reason ? {} : {}) };
  }

  /** 执行前的最终校验：授权必须存在、未被拒、且 patchHash 仍然一致。 */
  async assertExecutable(input: {
    actionId: string;
    repoRoot: string;
  }): Promise<PendingApproval> {
    const pending = this.pending;
    if (!pending || pending.actionId !== input.actionId) {
      throw new ApprovalError(
        "APPROVAL_NOT_FOUND",
        `没有与 ${input.actionId} 匹配的待审批动作`,
      );
    }
    if (this.decided.get(input.actionId) === "rejected") {
      throw new ApprovalError("APPROVAL_REJECTED", "该动作已被拒绝，不能执行");
    }
    if (!pending.approved) {
      throw new ApprovalError("APPROVAL_REQUIRED", "批准前不能执行该动作");
    }

    // 重新计算哈希：补丁参数或目标文件变化都会导致不一致。
    const current = await this.planPatch({
      repoRoot: input.repoRoot,
      relativePath: String(pending.args.path),
      search: String(pending.args.search),
      replace: String(pending.args.replace),
    });
    if (current.patchHash !== pending.patchHash) {
      throw new ApprovalError(
        "APPROVAL_STALE",
        "补丁参数或目标文件已变化，旧授权作废，需要重新审批",
      );
    }
    if (current.occurrences !== 1) {
      throw new ApprovalError(
        "APPROVAL_ANCHOR_INVALID",
        `替换锚点出现 ${current.occurrences} 次，必须唯一`,
      );
    }

    return { ...pending };
  }

  /** 动作执行完成后清理待审批状态。 */
  complete(actionId: string): void {
    if (this.pending?.actionId === actionId) {
      this.pending = undefined;
    }
  }

  /** 判定某动作是否被拒绝过（拒绝不能被重新 stage 绕过）。 */
  isRejected(actionId: string): boolean {
    return this.decided.get(actionId) === "rejected";
  }

  decisionOf(actionId: string): "approved" | "rejected" | undefined {
    return this.decided.get(actionId);
  }

  private requirePending(actionId: string): PendingApproval {
    if (!this.pending || this.pending.actionId !== actionId) {
      throw new ApprovalError(
        "APPROVAL_NOT_FOUND",
        `没有与 ${actionId} 匹配的待审批动作`,
      );
    }
    return this.pending;
  }
}
