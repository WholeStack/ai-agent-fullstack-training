// ============================================================================
// pi 会话 journal（落盘）适配层
//
// 事实核对：pi 0.84.4 中
//   - 低层 `Session` / `JsonlSessionRepo` / `NodeExecutionEnv` 均已实现；
//   - 高层 `AgentHarness.resume()` 是未实现的桩（抛 HarnessNotImplemented）。
// 因此本层只使用低层 journal：把「操作开始 / 工具启动 / 操作结束」
// 写入 JSONL，重启后可读回，用于判定「上次动作」三态（R3）。
// 真正的续跑由 runAgentLoopContinue 完成。
// ============================================================================

import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Session } from "@earendil-works/pi-agent-core";
import path from "node:path";

/**
 * 打开/创建一个落盘的 journal 会话。
 * sessionsRoot 放在工作区内的 .agent-runs/journal，随工作区一起被清理。
 */
export async function createDurableJournal(options: {
  checkpointRoot: string;
  sessionId?: string;
}): Promise<Session | undefined> {
  try {
    const fs = new NodeExecutionEnv({ cwd: options.checkpointRoot });
    const repo = new JsonlSessionRepo({
      fs,
      sessionsRoot: path.join(options.checkpointRoot, ".agent-runs", "journal"),
    });
    return await repo.create({
      cwd: options.checkpointRoot,
      id: options.sessionId,
    });
  } catch {
    // journal 不可用时退化为「仅靠存档判定」，不阻塞主流程。
    return undefined;
  }
}

/** 重新打开已有会话（恢复流程使用）。 */
export async function openDurableJournal(options: {
  checkpointRoot: string;
  sessionId?: string;
}): Promise<Session | undefined> {
  try {
    const fs = new NodeExecutionEnv({ cwd: options.checkpointRoot });
    const repo = new JsonlSessionRepo({
      fs,
      sessionsRoot: path.join(options.checkpointRoot, ".agent-runs", "journal"),
    });
    const list = await repo.list({ cwd: options.checkpointRoot });
    const metadata = options.sessionId
      ? list.find((item) => item.id === options.sessionId)
      : list[0];
    if (!metadata) return undefined;
    return await repo.open(metadata);
  } catch {
    return undefined;
  }
}
