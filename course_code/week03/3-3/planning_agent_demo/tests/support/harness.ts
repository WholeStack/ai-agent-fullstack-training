// ============================================================================
// 3.3 验收测试的公共脚手架
//
// 关键约束（课堂要求）：
//   - 异常退出实验只在临时工作区内进行；
//   - 用「子进程 + 可注入崩溃点」真实地模拟进程被杀，而不是 mock；
//   - 正常路径使用 faux 模型，不需要真实 Gateway。
//
// 这里提供：
//   makeTempWorkspace()  —— 复制 fixtures/demo-app 到临时工作区
//   runScenarioInChild() —— 在子进程里跑一个脚本化场景，可指定崩溃点
//   buildResponses()     —— 生成与场景对应的 faux 响应序列
// ============================================================================

import { spawn } from "node:child_process";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export const PATCH_SEARCH = [
  "  const expiresOn = session.expiresAt.slice(0, 10);",
  "  const currentDay = now.toISOString().slice(0, 10);",
  "  return expiresOn < currentDay;",
].join("\n");

export const PATCH_REPLACE = "  return Date.parse(session.expiresAt) <= now.getTime();";

export interface TempWorkspace {
  root: string;
  repoRoot: string;
  artifactRoot: string;
  checkpointRoot: string;
}

export async function makeTempWorkspace(prefix = "acc-"): Promise<TempWorkspace> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const repoRoot = path.join(root, "repo");
  await cp(path.join(PROJECT_ROOT, "fixtures", "demo-app"), repoRoot, {
    recursive: true,
  });
  return {
    root,
    repoRoot,
    artifactRoot: path.join(root, "artifacts"),
    checkpointRoot: root,
  };
}

export interface ChildRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** 子进程最后一行 RESULT_JSON 解析结果；没有则为空对象。 */
  result: Record<string, any>;
}

/**
 * 在子进程里执行 scripts/child-run.ts（与 npm start 共用 src/cli.ts）。
 * crashPoint 会在指定的代码位置强制 process.exit(137)，
 * 用于真实模拟"进程在存档/落盘之间被杀"。
 */
export function runScenarioInChild(options: {
  scenario: string;
  workspaceRoot: string;
  crashPoint?: string;
  runId?: string;
  /** run（默认）/ resume / replay；resume 与 replay 需要 runId。 */
  mode?: "run" | "resume" | "replay";
  /** 人工决定：只在 resume 模式有意义。 */
  decision?: "approve" | "reject";
  /** 第 N 轮结束后优雅暂停（存档已写、进程正常退出）。 */
  pauseAfter?: number;
  /** 自动批准待审批补丁；补丁仍走完整校验，只在 decisions 里记 by:"auto"。 */
  autoApprove?: boolean;
  taskPrompt?: string;
  timeoutMs?: number;
}): Promise<ChildRunResult> {
  const args = [
    "--import",
    "tsx",
    path.join(PROJECT_ROOT, "scripts", "child-run.ts"),
    "--scenario",
    options.scenario,
    "--workspace",
    options.workspaceRoot,
  ];
  if (options.pauseAfter !== undefined) {
    args.push("--pause-after", String(options.pauseAfter));
  }
  if (options.autoApprove) args.push("--auto-approve");
  if (options.crashPoint) args.push("--crash-point", options.crashPoint);
  if (options.runId) args.push("--run-id", options.runId);
  if (options.mode === "resume") args.push("--resume", options.runId ?? "");
  if (options.mode === "replay") args.push("--replay", options.runId ?? "");
  if (options.decision === "approve") args.push("--approve");
  if (options.decision === "reject") args.push("--reject");
  if (options.taskPrompt) args.push(options.taskPrompt);

  const { promise, resolve, reject } = Promise.withResolvers<ChildRunResult>();
  const child = spawn(process.execPath, args, {
    cwd: PROJECT_ROOT,
    env: { ...process.env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 60_000);
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    const result: ChildRunResult = { code, signal, stdout, stderr, result: {} };
    const line = stdout
      .split("\n")
      .reverse()
      .find((item) => item.startsWith("RESULT_JSON:"));
    if (line) result.result = JSON.parse(line.slice("RESULT_JSON:".length));
    resolve(result);
  });
  child.on("error", reject);
  return promise;
}
