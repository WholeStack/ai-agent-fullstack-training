// ============================================================================
// 课堂项目入口：参数解析、工作区准备、三个入口（运行 / 恢复 / 重跑）与报告输出。
//
// 真实 Gateway 入口（src/main.ts）与脚本化实验入口（scripts/child-run.ts）
// 共用本模块：两者只替换"谁来出下一个工具调用"，参数语义与报告完全一致。
// 也就是说，课堂上用脚本化模型看到的暂停/审批/重跑行为，
// 与接真实 Gateway 时走的是同一套代码。
//
// 参数（属于课堂项目入口，不是 pi CLI 的参数）：
//   --workspace <dir>     工作区；恢复与重跑必须指向同一个工作区
//   --pause-after <N>     第 N 个完整轮次结束、存档写盘之后优雅暂停
//   --auto-approve        机器放行待审批补丁（仍走暂存、patchHash 校验与落盘）
//   --resume <runId>      先检查再恢复
//   --approve / --reject  恢复时对存档里待审批补丁的人工决定
//   --replay <runId>      原任务输入 + 初始代码，在独立工作区重跑
//   --crash-point <name>  在指定点位强制退出，模拟异常终止（仅实验用）
//   --run-id <id>         指定 runId
// ============================================================================

import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

import { runPlanningAgent, DEFAULT_TASK_PROMPT, type RunPlanningAgentResult } from "./agent-runner.js";
import { checkpointPath, loadCheckpoint, type CheckpointEnvelope } from "./checkpoint.js";
import { createFreshRunPlan, summarizeTests, type FreshRunPlan } from "./fresh-run.js";
import { createExecutionContext, type DemoExecutionContext } from "./run-context.js";
import { prepareResume, ResumeRejected, type ResumeInspection } from "./resume.js";
import { isTerminalStatus, type TaskRecord } from "./task-record.js";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DEMO_APP_ROOT = path.join(PROJECT_ROOT, "fixtures", "demo-app");

export type CliMode = "run" | "resume" | "replay";

export interface CliCommand {
  mode: CliMode;
  /** 恢复 / 重跑的目标 runId。 */
  targetRunId?: string;
  /** 新运行的 runId（仅 run 模式）。 */
  runId?: string;
  taskPrompt?: string;
  workspace?: string;
  pauseAfter?: number;
  autoApprove: boolean;
  /** 人工决定；缺省表示"还没有决定"。 */
  decision?: "approve" | "reject";
  decisionReason?: string;
  crashPoint?: string;
  help?: boolean;
}

/** 参数错误一律在这里抛出，由入口统一转成退出码 2。 */
export class CliError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CliError";
  }
}

/** 需要跟一个取值的参数。 */
const VALUE_FLAGS: Record<string, true> = {
  "--resume": true,
  "--replay": true,
  "--pause-after": true,
  "--workspace": true,
  "--run-id": true,
  "--crash-point": true,
};

export function parseCliArgs(argv: string[]): CliCommand {
  const command: CliCommand = { mode: "run", autoApprove: false };
  const rest: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--help" || token === "-h") {
      command.help = true;
      continue;
    }
    if (token === "--auto-approve") {
      command.autoApprove = true;
      continue;
    }
    if (token === "--approve" || token === "--reject") {
      if (command.decision) {
        throw new CliError("USAGE", "--approve 与 --reject 只能给一个。");
      }
      command.decision = token === "--approve" ? "approve" : "reject";
      continue;
    }
    if (VALUE_FLAGS[token]) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliError("USAGE", `${token} 需要一个值。`);
      }
      index += 1;
      if (token === "--resume" || token === "--replay") {
        if (command.mode !== "run") {
          throw new CliError("USAGE", "--resume 与 --replay 只能给一个。");
        }
        command.mode = token === "--resume" ? "resume" : "replay";
        command.targetRunId = value;
      } else if (token === "--pause-after") {
        // 非法值直接报错，避免"传了参数却没有暂停"这种静默失效。
        const turn = Number(value);
        if (!Number.isInteger(turn) || turn < 1) {
          throw new CliError("USAGE", `--pause-after 需要一个正整数轮次，收到：${value}`);
        }
        command.pauseAfter = turn;
      } else if (token === "--workspace") {
        command.workspace = path.resolve(value);
      } else if (token === "--run-id") {
        command.runId = value;
      } else {
        command.crashPoint = value;
      }
      continue;
    }
    if (token.startsWith("--")) {
      throw new CliError("USAGE", `未知参数：${token}`);
    }
    rest.push(token);
  }

  if (command.decision && command.mode !== "resume") {
    throw new CliError("USAGE", "--approve / --reject 只用于 --resume 的待审批动作。");
  }
  if (command.mode !== "run" && !command.workspace) {
    throw new CliError(
      "USAGE",
      `${command.mode === "resume" ? "恢复" : "重跑"}必须给出 --workspace <上次的工作区>。`,
    );
  }
  if (rest.length > 0) command.taskPrompt = rest.join(" ");
  return command;
}

export interface CliModel {
  model: Model<any>;
  streamFn: StreamFn;
}

export interface RunCliOptions {
  argv: string[];
  /** 由入口决定模型：真实 Gateway 或脚本化 faux。 */
  createModel: (command: CliCommand) => CliModel | Promise<CliModel>;
  signal?: AbortSignal;
  /** 文本增量输出（模型自然语言回复）。 */
  onText?: (delta: string) => void;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export interface CliOutcome {
  command: CliCommand;
  exitCode: number;
  workspace?: string;
  repoRoot?: string;
  /** 运行结果；等待人工决定而没启动模型时为 undefined。 */
  result?: RunPlanningAgentResult;
  /** 恢复 / 重跑前的检查结果。 */
  inspection?: ResumeInspection;
  /** 重跑计划（含原运行对照信息）。 */
  replay?: FreshRunPlan;
}

/**
 * 准备一个工作区。已有 <dir>/repo 时直接复用（恢复与重跑都要求"还是原来那个环境"）；
 * 没有则从 fixtures/demo-app 复制一份初始代码。
 */
async function resolveWorkspace(directory?: string, initialize = true): Promise<{
  projectRoot: string;
  repoRoot: string;
  artifactRoot: string;
}> {
  const projectRoot = directory ?? await mkdtemp(path.join(tmpdir(), "state-agent-"));
  const repoRoot = path.join(projectRoot, "repo");
  if (initialize) await cp(DEMO_APP_ROOT, repoRoot, { recursive: true, force: false });
  return {
    projectRoot,
    repoRoot,
    artifactRoot: path.join(projectRoot, "artifacts"),
  };
}

export async function runCli(options: RunCliOptions): Promise<CliOutcome> {
  const out = options.out ?? ((line: string) => console.log(line));
  const err = options.err ?? ((line: string) => console.error(line));
  let command: CliCommand;
  try {
    command = parseCliArgs(options.argv);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return { command: { mode: "run", autoApprove: false }, exitCode: 2 };
  }
  if (command.help) {
    printUsage(out);
    return { command, exitCode: 0 };
  }

  if (command.mode === "replay") {
    return runReplay(command, options, out, err);
  }

  const workspace = await resolveWorkspace(command.workspace, command.mode !== "resume");
  const executionContext = createExecutionContext({
    projectRoot: workspace.projectRoot,
    repoRoot: workspace.repoRoot,
    artifactRoot: workspace.artifactRoot,
    runtimeRoot: PROJECT_ROOT,
  });
  const digestFiles = digestList(executionContext);

  if (command.mode === "resume") {
    let inspection: ResumeInspection;
    try {
      inspection = (await prepareResume({
        projectRoot: workspace.projectRoot,
        runId: command.targetRunId!,
        digestFiles,
      })).inspection;
    } catch (error) {
      return reportRejected(command, workspace.projectRoot, error, out, err);
    }

    // 有决定就执行决定；没有决定且存在待审批动作时，只报告、不启动模型。
    const decision = command.decision
      ?? (inspection.pendingApproval && command.autoApprove ? "approve" : undefined);
    if (!decision && inspection.pendingApproval) {
      printResumeHeader(out, inspection, command, workspace.projectRoot);
      printPendingApproval(
        out,
        inspection.pendingApproval,
        inspection.runId,
        workspace.projectRoot,
      );
      return {
        command,
        exitCode: 0,
        workspace: workspace.projectRoot,
        repoRoot: workspace.repoRoot,
        inspection,
      };
    }
    if (decision && !inspection.pendingApproval) {
      err("存档中没有待审批动作，--approve / --reject 没有作用对象。");
      return {
        command,
        exitCode: 2,
        workspace: workspace.projectRoot,
        repoRoot: workspace.repoRoot,
        inspection,
      };
    }

    const payload = inspection.checkpoint.payload;
    printResumeHeader(out, inspection, command, workspace.projectRoot);
    if (decision) {
      // 决定必须能被核对到具体内容：批准的是哪一份补丁，就执行哪一份。
      out(`人工决定：${decision === "approve" ? "批准" : "拒绝"} ${inspection.pendingApproval!.actionId}`);
      out(`补丁内容：${JSON.stringify(inspection.pendingApproval!.args)}`);
      out(`补丁哈希：${inspection.pendingApproval!.patchHash}`);
    }
    const model = await options.createModel(command);
    const result = await runPlanningAgent({
      model: model.model,
      streamFn: model.streamFn,
      signal: options.signal,
      taskPrompt: payload.task.taskInput,
      executionContext,
      runId: command.targetRunId,
      restore: {
        task: payload.task,
        messages: payload.session.messages,
        plan: payload.plan,
        evidence: payload.evidence,
      },
      operatorDecision: decision
        ? {
          decision,
          by: command.decision ? "manual" : "auto",
          reason: command.decisionReason ?? "课堂实验：人工决定",
        }
        : undefined,
      autoApprove: command.autoApprove,
      pauseAfter: command.pauseAfter,
      crashPoint: command.crashPoint,
      onText: options.onText,
    });
    printRunReport(out, {
      result,
      workspace: workspace.projectRoot,
      runId: command.targetRunId!,
      title: "从存档恢复",
      transitionsFrom: payload.task.transitions.length,
    });
    return {
      command,
      exitCode: 0,
      workspace: workspace.projectRoot,
      repoRoot: workspace.repoRoot,
      inspection,
      result,
    };
  }

  // 新运行：同一工作区里已经有同 runId 的未终结存档时拒绝，不做静默覆盖。
  // 否则"暂停 → 继续"的实验做第二次就会把上一次的存档顶掉，跨进程恢复无从谈起。
  const existing = await readExistingCheckpoint(workspace.projectRoot, command.runId);
  if (existing.envelope && !isTerminalStatus(existing.envelope.payload.task.status)) {
    const task = existing.envelope.payload.task;
    err(
      `运行 ${command.runId} 还有未终结的存档`
      + `（seq=${existing.envelope.seq}｜状态=${task.status}`
      + `｜轮数=${task.counters.turn}）：新运行会覆盖它，已拒绝。`,
    );
    err(`  接着跑：npm start -- --workspace ${workspace.projectRoot}`
      + ` --resume ${command.runId}`);
    err(`  从头跑：换一个 --run-id，或先删掉 `
      + `${checkpointPath(workspace.projectRoot, command.runId!)}`);
    return {
      command,
      exitCode: 3,
      workspace: workspace.projectRoot,
      repoRoot: workspace.repoRoot,
    };
  }
  if (existing.envelope) {
    out(`注意：运行的终态存档 ${command.runId} 将被本次新运行覆盖。`);
  }
  if (existing.problem) {
    out(`注意：已有存档无法解析（${existing.problem}），本次新运行会覆盖它。`);
  }

  const model = await options.createModel(command);
  const result = await runPlanningAgent({
    model: model.model,
    streamFn: model.streamFn,
    signal: options.signal,
    taskPrompt: command.taskPrompt ?? DEFAULT_TASK_PROMPT,
    executionContext,
    runId: command.runId,
    autoApprove: command.autoApprove,
    pauseAfter: command.pauseAfter,
    crashPoint: command.crashPoint,
    onText: options.onText,
  });
  printRunReport(out, {
    result,
    workspace: workspace.projectRoot,
    runId: result.record.runId,
    title: "开始执行",
    transitionsFrom: 0,
  });
  return {
    command,
    exitCode: 0,
    workspace: workspace.projectRoot,
    repoRoot: workspace.repoRoot,
    result,
  };
}

async function runReplay(
  command: CliCommand,
  options: RunCliOptions,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<CliOutcome> {
  const sourceProjectRoot = command.workspace!;
  let plan: FreshRunPlan;
  try {
    plan = await createFreshRunPlan({
      sourceProjectRoot,
      sourceRunId: command.targetRunId!,
      initialRepoRoot: DEMO_APP_ROOT,
    });
  } catch (error) {
    err(`重跑被拒绝：${error instanceof Error ? error.message : String(error)}`);
    return { command, exitCode: 3, workspace: sourceProjectRoot };
  }

  out("===== State Agent：独立工作区重跑 =====");
  out(`原运行：${plan.sourceRunId}（原存档只读，本次不会改写）`);
  out(`新运行：${plan.runId}`);
  out(`新工作区：${plan.workspaceRoot}`);
  for (const note of plan.disclaimer) out(`  ! ${note}`);
  out("原运行留下的测试结果（对照用）：");
  printTestSummary(out, plan.originalTestSummary);

  const executionContext = createExecutionContext({
    projectRoot: plan.workspaceRoot,
    repoRoot: plan.repoRoot,
    artifactRoot: plan.artifactRoot,
    runtimeRoot: PROJECT_ROOT,
  });
  const model = await options.createModel(command);
  const result = await runPlanningAgent({
    model: model.model,
    streamFn: model.streamFn,
    signal: options.signal,
    taskPrompt: plan.taskInput,
    executionContext,
    runId: plan.runId,
    autoApprove: command.autoApprove,
    pauseAfter: command.pauseAfter,
    crashPoint: command.crashPoint,
    onText: options.onText,
  });
  printRunReport(out, {
    result,
    workspace: plan.workspaceRoot,
    runId: plan.runId,
    title: "重跑结果",
    transitionsFrom: 0,
  });
  return {
    command,
    exitCode: 0,
    workspace: plan.workspaceRoot,
    repoRoot: plan.repoRoot,
    replay: plan,
    result,
  };
}

function reportRejected(
  command: CliCommand,
  workspace: string,
  error: unknown,
  out: (line: string) => void,
  err: (line: string) => void,
): CliOutcome {
  const code = (error as { code?: string }).code ?? "UNKNOWN";
  err(`恢复被拒绝：${code}　${error instanceof Error ? error.message : String(error)}`);
  const inspection = error instanceof ResumeRejected ? error.inspection : undefined;
  if (inspection) {
    for (const note of inspection.notes) err(`  - ${note}`);
    for (const action of inspection.unresolved) {
      err(`  ! ${action.toolName} ${action.state}：${action.reason}`);
    }
    err("已停止自动推进：请人工核查工作区后，再决定是重新执行还是手动恢复。");
  }
  out(`工作区：${workspace}`);
  return { command, exitCode: 3, workspace, inspection };
}

function printUsage(out: (line: string) => void): void {
  out("用法：npm start -- [参数] [任务描述]");
  out("  --workspace <dir>    工作区目录（新运行可省略，会自动建临时工作区）");
  out("  --pause-after <N>    第 N 轮结束、存档写盘之后优雅暂停（不是失败）");
  out("  --auto-approve       自动放行待审批补丁（仍走完整审批流程，记 by:auto）");
  out("  --resume <runId>     先检查存档、工作区与任务状态，再续跑");
  out("  --approve            恢复时批准待审批补丁（人工入口，记 by:manual）");
  out("  --reject             恢复时拒绝待审批补丁（拒绝后不写源码）");
  out("  --replay <runId>     原任务输入 + 初始代码，在独立工作区重跑");
  out("  --crash-point <name> 强制退出，模拟异常终止（实验用）");
  out("  --run-id <id>        指定 runId");
}

/**
 * 读同一 runId 的已有存档，供新运行判断"会不会顶掉别人的进度"。
 *   envelope —— 存档存在且可解析；
 *   problem  —— 文件在但读不了（损坏 / 版本不符），把原因带回去提示；
 *   两者都没有 —— 这个 runId 还没有存档。
 */
async function readExistingCheckpoint(
  projectRoot: string,
  runId?: string,
): Promise<{ envelope?: CheckpointEnvelope; problem?: string }> {
  if (!runId) return {};
  try {
    return { envelope: await loadCheckpoint(projectRoot, runId) };
  } catch (error) {
    const code = (error as { code?: string }).code ?? "CHECKPOINT_UNREADABLE";
    if (code === "CHECKPOINT_NOT_FOUND") return {};
    return {
      problem: `${code}：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function digestList(context: DemoExecutionContext): string[] {
  return [
    context.targetSource,
    ...context.targetSuite.files,
    ...context.boundarySuite.files,
    ...context.regressionSuite.files,
  ];
}

/** 停止码 → 课堂报告里的停止原因。未列出的停止码原样输出。 */
function stopReasonOf(result: RunPlanningAgentResult): string {
  const stopCode = result.state.stopCode;
  if (!stopCode) return "自然结束（无停止码）";
  return stopCode;
}

function finalResultOf(record: TaskRecord): string {
  if (record.status === "completed") return "completed｜完成契约已满足";
  if (record.status === "failed") return `失败（${record.stopCode ?? "未给出原因"}）`;
  if (record.status === "cancelled") return "已取消";
  if (record.status === "waiting_approval") return "未终结（等待人工批准或拒绝）";
  if (record.status === "suspended") {
    return `未终结（已暂停：${record.stopCode ?? "未给出原因"}，人工核查后可恢复）`;
  }
  return "未终结（可从存档继续）";
}

function printResumeHeader(
  out: (line: string) => void,
  inspection: ResumeInspection,
  command: CliCommand,
  workspace: string,
): void {
  const { payload } = inspection.checkpoint;
  out("===== State Agent：从存档恢复 =====");
  out(
    `恢复自：seq=${inspection.checkpoint.seq}｜任务状态=${payload.task.status}`
    + `｜代码版本=${payload.workspace.codeRevision}`,
  );
  out(`任务标识：${payload.task.runId}（沿用原任务输入与 runId=${command.targetRunId}）`);
  out(
    `已保留：计划 v${payload.plan?.version ?? "-"}｜证据 ${payload.evidence.length} 条`
    + `｜轮数 ${payload.task.counters.turn}｜工具调用 ${payload.task.counters.toolCalls}`
    + `｜会话历史 ${payload.session.messages.length} 条`
    + `｜存档 seq=${payload.task.counters.checkpoints}`,
  );
  out(`可恢复：${inspection.canResume}`);
  for (const note of inspection.notes) out(`  - ${note}`);
  printRunPlan(out, payload.task, payload.plan?.steps ?? []);
  out(`存档：${checkpointPath(workspace, command.targetRunId!)}`);
}

function printPendingApproval(
  out: (line: string) => void,
  pending: { toolName: string; args: Record<string, unknown> },
  runId: string,
  workspace: string,
): void {
  out("");
  out("待人工确认：");
  out(`  - ${pending.toolName} ${JSON.stringify(pending.args)}`);
  out(`  - 批准：npm start -- --resume ${runId} --workspace ${workspace} --approve`);
  out(`  - 拒绝：npm start -- --resume ${runId} --workspace ${workspace} --reject`);
  out("  （给出决定之前不会启动模型，也不会写入源码。）");
}

function printRunPlan(
  out: (line: string) => void,
  record: TaskRecord,
  planSteps: { id: string; status: string; evidenceIds: string[] }[],
): void {
  const evidenceCount = new Map<string, number>();
  for (const step of record.steps) {
    evidenceCount.set(step.stepId, step.evidenceIds.length);
  }
  out("步骤状态：");
  if (planSteps.length === 0) {
    out("  - （尚未创建计划）");
    return;
  }
  for (const step of planSteps) {
    out(`  - ${step.id}：${step.status}，证据 ${evidenceCount.get(step.id) ?? 0} 条`);
  }
}

function printTransitions(
  out: (line: string) => void,
  record: TaskRecord,
  from: number,
): void {
  const transitions = record.transitions.slice(from);
  if (transitions.length === 0) return;
  out("状态迁移：");
  for (const item of transitions) {
    const detail = item.detail ? `（${item.detail}）` : "";
    out(`  #${item.seq} ${item.from} -(${item.event})-> ${item.to}${detail}`);
  }
}

function printTestSummary(
  out: (line: string) => void,
  summary: { stepId: string; scope?: string; exitCode?: number; ok: boolean }[],
): void {
  if (summary.length === 0) {
    out("  - （原运行没有留下测试记录）");
    return;
  }
  for (const item of summary) {
    out(
      `  - ${item.stepId}/${item.scope ?? "unknown"} `
      + `exit=${item.exitCode ?? "unknown"} ${item.ok ? "通过" : "未通过"}`,
    );
  }
}

export interface RunReportInput {
  result: RunPlanningAgentResult;
  workspace: string;
  runId: string;
  title: string;
  /** 本进程新增的迁移从哪一条开始（恢复时要跳过上一次的迁移）。 */
  transitionsFrom: number;
}

function printRunReport(
  out: (line: string) => void,
  input: RunReportInput,
): void {
  const { result } = input;
  const plan = result.session.snapshot();
  const record = result.record;

  out("");
  out(`===== State Agent：${input.title} =====`);
  out(`运行 ID：${input.runId}`);
  out(`工作区：${input.workspace}`);
  out(`停止原因：${stopReasonOf(result)}`);
  if (result.state.stopCode === "MODEL_ERROR") {
    const lastAssistant = result.messages.findLast((message) => message.role === "assistant");
    if (lastAssistant?.role === "assistant" && lastAssistant.errorMessage) {
      out(`模型错误：${lastAssistant.errorMessage}`);
    }
  }
  out(`任务状态：${record.status}`);
  out(`代码版本：${result.runtime.getRevision()}`);
  out(`执行轮数：${result.state.turn}`);
  out(
    `续跑方式：${result.resumeEntry === "continue"
      ? `runAgentLoopContinue（回灌会话历史 ${result.messages.length} 条，不重发任务输入）`
      : "runAgentLoop（新运行，从任务输入起步）"}`,
  );
  out(`计划版本：v${plan?.version ?? "-"}`);
  out(`证据：${result.session.evidence.list().length} 条`);
  printTransitions(out, record, input.transitionsFrom);
  printRunPlan(out, record, plan?.steps ?? []);
  // 测试退出码与交付物是"任务真的做完了吗"的判据，不能只报最终状态。
  out("测试结果：");
  printTestSummary(out, summarizeTests(record));
  out(`读取文件：${[...result.state.evidence.readFiles].join("、") || "无"}`);
  out(`写入产物：${[...result.state.evidence.writtenArtifacts].join("、") || "无"}`);
  out(`存档：seq=${record.counters.checkpoints}（${checkpointPath(input.workspace, input.runId)}）`);

  if (record.pendingApproval) {
    printPendingApproval(out, record.pendingApproval, input.runId, input.workspace);
  }
  const decisions = record.decisions.map(
    (item) => `${item.actionId}→${item.decision}（by:${item.by}）`,
  );
  if (decisions.length > 0) out(`人工决定：${decisions.join("，")}`);
  out(`任务最终结果：${finalResultOf(record)}`);
}
