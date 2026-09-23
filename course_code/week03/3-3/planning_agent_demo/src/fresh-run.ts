// ============================================================================
// 3.3 R5：失败排查——原任务输入 + 对应初始代码的独立工作区重跑
//
// 规则：
//   - 用原任务输入，在「初始代码」的独立工作区重新执行；
//   - 保留原运行记录（原存档只读，绝不修改）；
//   - 新运行的日志 / 修改 / 测试结果另存；
//   - 不默认继承危险操作权限（dangerousPermissions 默认 false）；
//   - 不承诺模型会选择相同路径，也不承诺原错误一定再次出现。
// ============================================================================

import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadCheckpoint } from "./checkpoint.js";
import type { TaskRecord } from "./task-record.js";

export interface FreshRunPlan {
  /** 新运行的 runId。 */
  runId: string;
  /** 原运行 runId（用于对照）。 */
  sourceRunId: string;
  /** 原任务输入，原样复用。 */
  taskInput: string;
  /** 独立工作区路径。 */
  workspaceRoot: string;
  repoRoot: string;
  artifactRoot: string;
  /** 新运行日志目录。 */
  logRoot: string;
  /** 危险操作权限：默认不继承。 */
  dangerousPermissions: false;
  /** 必须向使用者说明的限制。 */
  disclaimer: string[];
  /** 原运行的记录快照（只读，用于对照）。 */
  originalTask: TaskRecord;
  /** 原运行日志中的测试结果摘要（对照用）。 */
  originalTestSummary: TestSummary[];
}

export interface TestSummary {
  stepId: string;
  scope?: string;
  exitCode?: number;
  ok: boolean;
}

export interface CreateFreshRunInput {
  /** 原运行所在的工作区；用于读取原存档。 */
  sourceProjectRoot: string;
  sourceRunId: string;
  /** 初始代码来源目录（fixtures/demo-app 的副本）。 */
  initialRepoRoot: string;
}

/** 复制初始代码到全新临时工作区，并生成重跑计划。 */
export async function createFreshRunPlan(
  input: CreateFreshRunInput,
): Promise<FreshRunPlan> {
  const checkpoint = await loadCheckpoint(input.sourceProjectRoot, input.sourceRunId);
  const original = checkpoint.payload.task;

  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "agent-rerun-"));
  const repoRoot = path.join(workspaceRoot, "repo");
  const artifactRoot = path.join(workspaceRoot, "artifacts");
  const logRoot = path.join(workspaceRoot, "logs");

  // 始终从「初始代码」复制，避免继承上一次运行的修改。
  await cp(input.initialRepoRoot, repoRoot, { recursive: true });

  const runId = `rerun-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  return {
    runId,
    sourceRunId: input.sourceRunId,
    taskInput: original.taskInput,
    workspaceRoot,
    repoRoot,
    artifactRoot,
    logRoot,
    dangerousPermissions: false,
    disclaimer: [
      "本次重跑使用原任务输入，但不承诺模型会选择相同路径。",
      "原错误不保证再次出现；两次运行的日志/修改/测试结果需分别对照。",
      "新运行不继承原运行的危险操作权限，审批状态从零开始。",
    ],
    originalTask: original,
    originalTestSummary: summarizeTests(original),
  };
}

/** 汇总一次运行的测试结果，供两次运行对照。 */
export function summarizeTests(task: TaskRecord): TestSummary[] {
  return task.steps.flatMap((step) =>
    step.toolCalls
      .filter((call) => call.toolName === "run_test")
      .map((call) => {
        // 退出码与范围记在工具产出的证据里，而不是工具返回的浅层字段上：
        // 这里必须读到真实退出码，否则两次运行对照就只剩"未通过"三个字。
        const payload = (call.output?.evidence as
          | { payload?: Record<string, unknown> }
          | undefined)?.payload ?? {};
        const exitCode = typeof payload.exitCode === "number"
          ? payload.exitCode
          : undefined;
        return {
          stepId: step.stepId,
          scope: typeof payload.scope === "string" ? payload.scope : undefined,
          exitCode,
          ok: call.ok && exitCode === 0,
        };
      }),
  );
}
