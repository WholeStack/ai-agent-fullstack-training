// ============================================================================
// 课堂实验入口：中断 → 恢复 的完整闭环，可反复执行
//
// 每跑一次都在全新的临时工作区里完整走一遍，所以上一次运行不会影响下一次：
//   第 1 段：跑到第 N 轮结束、存档写盘之后优雅暂停（exit 0，任务仍是 running）
//   第 2 段：拿同一份存档续跑，核对"回灌会话历史续跑、轮数接着数、不重发任务输入"
//
// 与 npm start 共用同一个入口（src/main.ts → src/cli.ts），
// 这里只把两次运行串起来并核对结果，不复制任何参数语义。
//
// 参数：--pause-after <N>（默认 6）、--run-id <id>（默认 run-lab）、
//       --workspace <dir>（复用已有工作区；默认新建临时工作区）、[任务描述]
// 退出码：0 = 闭环成立；1 = 有断言不成立（逐条打印 ✗）。
// ============================================================================

import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_TASK_PROMPT } from "../src/agent-runner.js";
import { loadCheckpoint } from "../src/checkpoint.js";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** 本脚本自己的参数（其余参数原样交给 src/cli.ts 的语义：--workspace/--run-id/--pause-after）。 */
const FLAG_KEYS: Record<string, "pauseAfter" | "runId" | "workspace"> = {
  "pause-after": "pauseAfter",
  "run-id": "runId",
  workspace: "workspace",
};

function parseArgs(argv: string[]): {
  pauseAfter: number;
  runId: string;
  workspace?: string;
  scripted: boolean;
  taskPrompt: string;
} {
  const values: {
    pauseAfter?: string;
    runId?: string;
    workspace?: string;
  } = {};
  const rest: string[] = [];
  let scripted = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--scripted") {
      scripted = true;
      continue;
    }
    if (!token.startsWith("--")) {
      rest.push(token);
      continue;
    }
    const key = FLAG_KEYS[token.slice(2)];
    if (!key) throw new Error(`未知参数：${token}`);
    values[key] = argv[index + 1];
    index += 1;
  }
  const pauseAfter = Number(values.pauseAfter ?? "6");
  if (!Number.isInteger(pauseAfter) || pauseAfter < 1) {
    throw new Error(`--pause-after 需要一个正整数，收到：${values.pauseAfter}`);
  }
  return {
    pauseAfter,
    runId: values.runId ?? "run-lab",
    workspace: values.workspace,
    scripted,
    taskPrompt: rest.join(" ") || DEFAULT_TASK_PROMPT,
  };
}

interface PhaseRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 跑一段：与 npm start 同一个入口，输出边跑边打印（课堂上要能看着它跑）。 */
function runPhase(args: string[], scripted: boolean): Promise<PhaseRun> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.join(PROJECT_ROOT, scripted ? "scripts/child-run.ts" : "src/main.ts"),
      ...(scripted ? ["--scenario", "ac_full"] : []), ...args],
    { cwd: PROJECT_ROOT, env: { ...process.env } },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    process.stderr.write(chunk);
  });
  const { promise, resolve, reject } = Promise.withResolvers<PhaseRun>();
  child.on("close", (code) => resolve({ code, stdout, stderr }));
  child.on("error", reject);
  return promise;
}

/** 会话消息里的文字：用来核对任务输入有没有被重发一遍。 */
function textOf(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part as { text?: string }).text ?? "")
    .join("");
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  // 工作区由 src/cli.ts 的 resolveWorkspace 负责（没有 repo 时从 fixtures/demo-app 复制），
  // 这里只负责"每跑一次就换一个新的"，重复执行才有意义。
  const workspace = options.workspace
    ?? await mkdtemp(path.join(tmpdir(), "lab-cycle-"));

  const first = await runPhase([
    "--workspace",
    workspace,
    "--run-id",
    options.runId,
    "--pause-after",
    String(options.pauseAfter),
    "--auto-approve",
    options.taskPrompt,
  ], options.scripted);
  const paused = await loadCheckpoint(workspace, options.runId);
  if (first.code !== 0 || paused.payload.task.status !== "running"
    || paused.payload.task.stopCode !== "INTERRUPTED") {
    console.error(`闭环未开始：第 1 段不是优雅暂停，exit=${first.code}，`
      + `状态=${paused.payload.task.status}，停止原因=${paused.payload.task.stopCode ?? "无"}。`);
    console.error(`请先处理环境或任务问题；工作区与存档保留在 ${workspace}`);
    return 1;
  }
  const historyBefore = paused.payload.session.messages;
  const lastBefore = historyBefore.at(-1)?.role;

  const second = await runPhase([
    "--workspace",
    workspace,
    "--resume",
    options.runId,
    "--auto-approve",
  ], options.scripted);
  const resumed = await loadCheckpoint(workspace, options.runId);
  const historyAfter = resumed.payload.session.messages;

  // 逐条核对：都是从存档/退出码里读出来的事实，不靠模型"说自己完成了"。
  const checks: [string, boolean][] = [
    [
      `第 1 段是优雅暂停（exit=${first.code}，任务状态=${paused.payload.task.status}）`,
      first.code === 0 && paused.payload.task.status === "running",
    ],
    [
      `暂停点留下了会话历史（${historyBefore.length} 条，最后一条是 ${lastBefore}）`,
      historyBefore.length > 0,
    ],
    [
      `恢复走 pi 的续跑入口（不重发任务输入）`,
      second.stdout.includes("续跑方式：runAgentLoopContinue")
      && historyAfter.filter((m) => textOf(m) === options.taskPrompt).length === 1,
    ],
    [
      `会话历史累积：暂停前的 ${historyBefore.length} 条原样保留（恢复后 ${historyAfter.length} 条）`,
      historyAfter.length > historyBefore.length
      && historyBefore.every((message, index) => textOf(message) === textOf(historyAfter[index])),
    ],
    [
      `轮数接着数（${paused.payload.task.counters.turn} → ${resumed.payload.task.counters.turn}）`
      + `，存档序号继续（${paused.seq} → ${resumed.seq}）`,
      resumed.payload.task.counters.turn > paused.payload.task.counters.turn
      && resumed.seq > paused.seq,
    ],
    [
      `恢复后满足完成契约（exit=${second.code}，状态=${resumed.payload.task.status}）`,
      second.code === 0 && resumed.payload.task.status === "completed",
    ],
    [
      options.scripted ? "固定动作修复只执行一次" : "恢复保留暂停前的补丁证据",
      options.scripted
        ? resumed.payload.evidence.filter((item) => item.kind === "diff").length === 1
        : paused.payload.evidence.filter((item) => item.kind === "diff")
          .every((item) => resumed.payload.evidence.some((next) => next.id === item.id)),
    ],
  ];

  const lines = [
    "",
    "===== 中断 → 恢复 闭环 =====",
    `工作区：${workspace}`,
    `第 1 段：exit=${first.code}｜任务状态=${paused.payload.task.status}`
    + `｜轮数=${paused.payload.task.counters.turn}｜会话历史=${historyBefore.length} 条`
    + `｜存档 seq=${paused.seq}`,
    `第 2 段：exit=${second.code}｜任务状态=${resumed.payload.task.status}`
    + `｜停止原因=${resumed.payload.task.stopCode ?? "无"}`
    + `｜轮数=${resumed.payload.task.counters.turn}｜会话历史=${historyAfter.length} 条`
    + `｜存档 seq=${resumed.seq}`,
    "断言：",
    ...checks.map(([name, ok]) => `  ${ok ? "✓" : "✗"} ${name}`),
  ];
  console.log(lines.join("\n"));

  const failed = checks.filter(([, ok]) => !ok);
  console.log(failed.length === 0
    ? "结论：闭环成立；同一条命令可反复执行（每次都是新工作区）。"
    : `结论：有 ${failed.length} 条断言不成立，恢复链路需要核查。`);
  return failed.length === 0 ? 0 : 1;
}

process.exit(await main());
