// ============================================================================
// 3.3 R2：存档（Checkpoint）
//
// 存档保存「恢复所需的信息」：
//   任务、计划、步骤记录、证据、会话引用/历史、工作区标识、
//   代码版本与摘要、运行计数、待审批动作、人工决定。
//
// 明确规则：
//   - 存档格式：带 schemaVersion + checksum 的 JSON 信封；
//   - 写入方式：先写临时文件再 rename，避免半截文件（原子替换）；
//   - 默认在「完整轮次结束」后保存；进入等待审批前必须保存；
//   - 保存失败：不推进流程，保留最近一份有效存档，并报告原因；
//   - 校验：schemaVersion 必须是当前版本；checksum 必须匹配；
//     必填字段必须齐全，否则视为损坏。
// ============================================================================

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { Evidence, PlanSnapshot } from "./plan-store.js";
import type { TaskRecord } from "./task-record.js";

/**
 * 当前存档格式版本；不兼容的旧档会被拒绝。
 * v2：运行状态机（waiting_tool/waiting_approval）与 transitions、存档序号入档。
 */
export const CHECKPOINT_SCHEMA_VERSION = 2;

/** 工作区标识与代码版本：恢复时用于确认"还是原来那个环境"。 */
export interface WorkspaceReference {
  /** 工作区标识（绝对路径 + 目录名）。 */
  id: string;
  repoRoot: string;
  projectRoot: string;
  /** 上一次存档时的代码版本号（runtime 的 rN）。 */
  codeRevision: string;
  /** 目标源码 + 相关测试文件的摘要；用于检测"未存档的写入"。 */
  repoDigest: string;
}

/** 存档信封：业务对象 + 元数据 + 校验。 */
export interface CheckpointEnvelope {
  schemaVersion: number;
  runId: string;
  createdAt: number;
  /**
   * 存档序号（第几份存档），取自 payload.task.counters.checkpoints。
   * 与 payload 一起受校验和保护，恢复时用它说明"从哪一份继续"。
   */
  seq: number;
  /** 业务对象：恢复时被还原的全部内容。 */
  payload: {
    task: TaskRecord;
    plan?: PlanSnapshot;
    evidence: Evidence[];
    session: {
      /** 会话历史；恢复续跑时回灌给 pi 的 Loop。 */
      messages: AgentMessage[];
      /** pi journal 中的会话 id（会话引用）。 */
      sessionId?: string;
      /** 上次已闭合的操作 id；用于判定"上次动作是否完成"。 */
      lastOperationId?: string;
    };
    workspace: WorkspaceReference;
  };
  /** payload 的 sha256；校验失败视为损坏。 */
  checksum: string;
}

export class CheckpointError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CheckpointError";
  }
}

export interface SaveCheckpointInput {
  projectRoot: string;
  runId: string;
  task: TaskRecord;
  plan?: PlanSnapshot;
  evidence: Evidence[];
  messages: AgentMessage[];
  sessionId?: string;
  lastOperationId?: string;
  workspace: WorkspaceReference;
  now?: number;
}

/** 存档目录：放在临时工作区内，不污染课堂仓库。 */
export function checkpointDir(projectRoot: string): string {
  return path.join(projectRoot, ".agent-runs");
}

export function checkpointPath(projectRoot: string, runId: string): string {
  return path.join(checkpointDir(projectRoot), `${runId}.json`);
}

/**
 * 摘要算法：只覆盖目标源码与相关测试文件。
 * 全仓摘要会被 node_modules / 临时文件干扰，导致恢复时误判。
 */
export async function computeRepoDigest(
  repoRoot: string,
  files: string[],
): Promise<string> {
  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    const absolute = path.join(repoRoot, file);
    hash.update(`file:${file}\n`);
    try {
      hash.update(await readFile(absolute, "utf8"));
    } catch {
      hash.update("<missing>");
    }
    hash.update("\n");
  }
  return hash.digest("hex");
}

/** 计算信封的校验和；payload 走稳定序列化，避免键顺序影响。 */
export function computeChecksum(payload: CheckpointEnvelope["payload"]): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

/**
 * 保存存档。任一环节失败都会抛出 CheckpointError，
 * 且不会破坏上一份有效存档（先写 .tmp，成功后 rename）。
 */
export async function saveCheckpoint(
  input: SaveCheckpointInput,
): Promise<CheckpointEnvelope> {
  const payload: CheckpointEnvelope["payload"] = {
    task: input.task,
    plan: input.plan,
    evidence: input.evidence,
    session: {
      messages: input.messages,
      sessionId: input.sessionId,
      lastOperationId: input.lastOperationId,
    },
    workspace: input.workspace,
  };
  const envelope: CheckpointEnvelope = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    runId: input.runId,
    createdAt: input.now ?? Date.now(),
    seq: input.task.counters.checkpoints,
    payload,
    checksum: computeChecksum(payload),
  };

  const directory = checkpointDir(input.projectRoot);
  const target = checkpointPath(input.projectRoot, input.runId);
  const temporary = `${target}.tmp`;

  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, JSON.stringify(envelope, null, 2), "utf8");
    // rename 是原子的：要么看到旧档，要么看到完整新档。
    await rename(temporary, target);
  } catch (error) {
    throw new CheckpointError(
      "CHECKPOINT_WRITE_FAILED",
      `存档写入失败，已保留最近一份有效存档：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return envelope;
}

/**
 * 读取并校验存档。校验失败一律拒绝，不做"尽量修复"。
 */
export async function loadCheckpoint(
  projectRoot: string,
  runId: string,
): Promise<CheckpointEnvelope> {
  const target = checkpointPath(projectRoot, runId);
  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch {
    throw new CheckpointError("CHECKPOINT_NOT_FOUND", `找不到存档：${target}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CheckpointError("CHECKPOINT_CORRUPT", "存档不是合法 JSON");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new CheckpointError("CHECKPOINT_CORRUPT", "存档结构不是对象");
  }
  const envelope = parsed as CheckpointEnvelope;

  if (envelope.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
    throw new CheckpointError(
      "CHECKPOINT_SCHEMA_MISMATCH",
      `存档版本不兼容：${envelope.schemaVersion}`,
    );
  }
  if (!envelope.payload || !envelope.payload.task || !envelope.payload.workspace) {
    throw new CheckpointError("CHECKPOINT_CORRUPT", "存档缺少必填字段");
  }
  if (envelope.runId !== envelope.payload.task.runId) {
    throw new CheckpointError(
      "CHECKPOINT_CORRUPT",
      "存档 runId 与任务记录不一致",
    );
  }
  if (envelope.seq !== envelope.payload.task.counters.checkpoints) {
    throw new CheckpointError(
      "CHECKPOINT_CORRUPT",
      "存档序号与任务记录不一致",
    );
  }
  const expected = computeChecksum(envelope.payload);
  if (expected !== envelope.checksum) {
    throw new CheckpointError(
      "CHECKPOINT_CORRUPT",
      "存档校验和不匹配，文件可能损坏或被改写",
    );
  }

  return envelope;
}

/** 列出工作区内已有的存档，供 R5 对照两次运行。 */
export async function listCheckpoints(projectRoot: string): Promise<string[]> {
  const directory = checkpointDir(projectRoot);
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.replace(/\.json$/, ""))
      .sort();
  } catch {
    return [];
  }
}

/** 校验工作区仍然存在（A6：工作区缺失必须拒绝恢复）。 */
export async function assertWorkspaceExists(reference: WorkspaceReference): Promise<void> {
  try {
    const info = await stat(reference.projectRoot);
    if (!info.isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new CheckpointError(
      "WORKSPACE_MISSING",
      `工作区不存在或不可用：${reference.projectRoot}`,
    );
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
