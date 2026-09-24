// ============================================================================
// 3.3 验收测试
//
// A1–A7  ——  能力边界：中断恢复、结果不明、审批、授权失效、存档损坏、重跑
// A8–A10 ——  课堂三个场景：中断续跑 / 人工审批 / 独立工作区重跑
//
// 全部通过子进程真实执行 scripts/child-run.ts（与 npm start 共用 src/cli.ts），
// 断言落在真实产物上：存档、源码文件、交付物、状态迁移与退出码，
// 不以"编译通过"或"模型声称完成"作为通过依据。
// 异常退出只在临时工作区内进行。
// ============================================================================

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { computeRepoDigest, loadCheckpoint } from "../src/checkpoint.js";
import { prepareResume, ResumeRejected } from "../src/resume.js";
import { ApprovalGate } from "../src/approval.js";
import { makeTempWorkspace, runScenarioInChild } from "./support/harness.js";

const DIGEST_FILES = [
  "src/auth/session-policy.ts",
  "tests/session-policy.test.ts",
  "tests/session-boundary.test.ts",
  "tests/login-flow.test.ts",
];
const SOURCE = "src/auth/session-policy.ts";
const PATCH_RESULT = "Date.parse(session.expiresAt) <= now.getTime()";

const PATCH_SEARCH = [
  "  const expiresOn = session.expiresAt.slice(0, 10);",
  "  const currentDay = now.toISOString().slice(0, 10);",
  "  return expiresOn < currentDay;",
].join("\n");

async function sourceOf(workspace: { repoRoot: string }): Promise<string> {
  return readFile(path.join(workspace.repoRoot, SOURCE), "utf8");
}

/** 目标源码里出现修复后判断的次数：用于判断"到底写了几次"。 */
async function patchCount(workspace: { repoRoot: string }): Promise<number> {
  return (await sourceOf(workspace)).split(PATCH_RESULT).length - 1;
}

describe("A1 诊断完成后进程被杀，恢复时保留计划/证据/计数并从后续步骤继续", () => {
  it("存档保存后进程退出，恢复可继续且不回退进度", async () => {
    const ws = await makeTempWorkspace("a1-");
    const child = await runScenarioInChild({
      scenario: "ac1",
      workspaceRoot: ws.root,
      crashPoint: "after-checkpoint:3",
      runId: "run-a1",
    });
    // 崩溃点：进程被强制结束。
    expect(child.code).not.toBe(0);

    const envelope = await loadCheckpoint(ws.root, "run-a1");
    expect(envelope.payload.task.steps.find((s) => s.stepId === "read")?.status)
      .toBe("completed");
    expect(envelope.payload.evidence.length).toBeGreaterThan(0);
    expect(envelope.payload.plan?.steps[0].status).toBe("completed");

    // 恢复：先检查再还原；保留轮数与证据，不重置。
    const resumed = await prepareResume({
      projectRoot: ws.root,
      runId: "run-a1",
      digestFiles: DIGEST_FILES,
    });
    expect(resumed.task.steps.find((s) => s.stepId === "read")?.status)
      .toBe("completed");
    expect(resumed.evidence.length).toBeGreaterThan(0);
    expect(resumed.task.counters.turn).toBeGreaterThan(0);

    // 真正调 pi 续跑：从后续步骤继续，已完成的 read 不被重做。
    const resumedChild = await runScenarioInChild({
      scenario: "ac1",
      workspaceRoot: ws.root,
      mode: "resume",
      runId: "run-a1",
    });
    expect(resumedChild.code).toBe(0);
    const out = resumedChild.result;
    expect(out.canResume).toBe(true);
    expect(out.resumedFrom.turn).toBeGreaterThan(0);
    expect(out.resumedFrom.evidence).toBeGreaterThan(0);
    expect(out.resumedFromCheckpoint).toBe(true);
    // 从后续步骤继续：read 保持 completed，reproduce 已推进。
    const steps = out.resumedPlanFinal as { id: string; status: string }[];
    expect(steps.find((s) => s.id === "read")?.status).toBe("completed");
    expect(steps.find((s) => s.id === "reproduce")?.status).not.toBe("pending");
  }, 90_000);
});

describe("A2 补丁已写入但存档未保存，恢复时阻止重复写入", () => {
  it("补丁已落盘、下一份存档未写时进程被杀 → 结果不明，拒绝自动恢复", async () => {
    const ws = await makeTempWorkspace("a2-");
    // 批准补丁并落盘，但在保存该轮存档前进程被强制结束。
    const child = await runScenarioInChild({
      scenario: "ac_full",
      workspaceRoot: ws.root,
      crashPoint: "after-approval-before-checkpoint",
      runId: "run-a2",
      autoApprove: true,
    });
    expect(child.code).not.toBe(0);

    // 补丁确实已落盘，而且只有一次。
    expect(await patchCount(ws)).toBe(1);

    // 最新有效存档仍停留在旧代码版本，摘要与工作区不一致。
    const env = await loadCheckpoint(ws.root, "run-a2");
    const live = await computeRepoDigest(ws.repoRoot, DIGEST_FILES);
    expect(live).not.toBe(env.payload.workspace.repoDigest);

    const rejection = await prepareResume({
      projectRoot: ws.root,
      runId: "run-a2",
      digestFiles: DIGEST_FILES,
    }).then(
      () => undefined,
      (error: ResumeRejected) => error,
    );
    expect(rejection).toBeInstanceOf(ResumeRejected);
    expect(rejection?.code).toBe("RESULT_UNKNOWN");
    expect(rejection?.inspection?.unresolved.some((a) => a.toolName === "apply_patch"))
      .toBe(true);
    expect(rejection?.inspection?.notes.join(" ")).toContain("摘要不一致");

    // 恢复入口必须拒绝启动：重复执行一次也不得再写一次源码。
    const retry = await runScenarioInChild({
      scenario: "ac_full",
      workspaceRoot: ws.root,
      mode: "resume",
      runId: "run-a2",
      autoApprove: true,
    });
    expect(retry.code).toBe(3);
    expect(retry.result.canResume).toBe(false);
    expect(await patchCount(ws)).toBe(1);
  }, 90_000);
});

describe("A3 测试已启动但没有完整结果时中断，恢复后不记为通过", () => {
  it("缺少完整测试结果的步骤不得为 completed", async () => {
    const ws = await makeTempWorkspace("a3-");
    const child = await runScenarioInChild({
      scenario: "ac3",
      workspaceRoot: ws.root,
      crashPoint: "during-test",
      runId: "run-a3",
    });
    expect(child.code).not.toBe(0);

    const env = await loadCheckpoint(ws.root, "run-a3");
    const reproduce = env.payload.task.steps.find((s) => s.stepId === "reproduce");
    // 测试失败 ≠ 通过：不得为 completed。
    expect(reproduce?.status).not.toBe("completed");

    const inspection = await prepareResume({
      projectRoot: ws.root,
      runId: "run-a3",
      digestFiles: DIGEST_FILES,
    }).catch((error) => error as ResumeRejected);

    // 必须明确拒绝并给出核查信息（journal 中 run_test 已启动但无完成记录）。
    expect(inspection).toBeInstanceOf(ResumeRejected);
    const rejection = inspection as ResumeRejected;
    expect(rejection.code).toBe("RESULT_UNKNOWN");
    expect(rejection.inspection?.unresolved.some((a) => a.toolName === "run_test")).toBe(true);
  }, 90_000);
});

describe("A4 审批门：批准前不能执行，拒绝后不能执行，哈希变化即作废", () => {
  it("未批准时 assertExecutable 拒绝；拒绝后同样不能执行", async () => {
    const ws = await makeTempWorkspace("a4g-");
    const gate = new ApprovalGate();
    const plan = await gate.planPatch({
      repoRoot: ws.repoRoot,
      relativePath: SOURCE,
      search: PATCH_SEARCH,
      replace: `  return ${PATCH_RESULT};`,
    });
    const pending = gate.stage({ plan, stepId: "fix" });
    await expect(gate.assertExecutable({ actionId: pending.actionId, repoRoot: ws.repoRoot }))
      .rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });

    gate.reject(pending.actionId, "课堂拒绝");
    await expect(gate.assertExecutable({ actionId: pending.actionId, repoRoot: ws.repoRoot }))
      .rejects.toMatchObject({ code: "APPROVAL_NOT_FOUND" });
  }, 60_000);

  it("文件被外部修改后，哈希变化导致 APPROVAL_STALE", async () => {
    const ws = await makeTempWorkspace("a4s-");
    const gate = new ApprovalGate();
    const plan = await gate.planPatch({
      repoRoot: ws.repoRoot,
      relativePath: SOURCE,
      search: PATCH_SEARCH,
      replace: `  return ${PATCH_RESULT};`,
    });
    const pending = gate.stage({ plan, stepId: "fix" });
    gate.approve(pending.actionId);

    const target = path.join(ws.repoRoot, SOURCE);
    const content = await readFile(target, "utf8");
    await writeFile(target, `${content}\n// 外部改动\n`, "utf8");

    await expect(gate.assertExecutable({ actionId: pending.actionId, repoRoot: ws.repoRoot }))
      .rejects.toMatchObject({ code: "APPROVAL_STALE" });
  }, 60_000);
});

describe("A5 授权失效：批准前目标文件已变，恢复时不得落盘", () => {
  it("恢复后人工批准一份已经过时的补丁 → 拒绝执行，源码保持不变", async () => {
    const ws = await makeTempWorkspace("a5-");
    // 先把补丁挂起来等审批。
    await runScenarioInChild({
      scenario: "ac4",
      workspaceRoot: ws.root,
      runId: "run-a5",
    });
    const env = await loadCheckpoint(ws.root, "run-a5");
    expect(env.payload.task.pendingApproval).toBeDefined();

    // 审批之前，目标文件被外部改动。
    const target = path.join(ws.repoRoot, SOURCE);
    const content = await readFile(target, "utf8");
    await writeFile(target, `${content}\n// 外部改动\n`, "utf8");

    const approved = await runScenarioInChild({
      scenario: "ac4",
      workspaceRoot: ws.root,
      mode: "resume",
      runId: "run-a5",
      decision: "approve",
    });
    // 授权已失效：补丁不落盘，进程报错退出，也不继续跑模型。
    expect(approved.code).not.toBe(0);
    expect(await patchCount(ws)).toBe(0);
    expect(await sourceOf(ws)).toContain("// 外部改动");
  }, 90_000);
});

describe("A6 存档损坏/工作区缺失/任务终结时，恢复请求被明确拒绝", () => {
  it("存档损坏 → CHECKPOINT_CORRUPT，不启动模型或写工具", async () => {
    const ws = await makeTempWorkspace("a6c-");
    await runScenarioInChild({
      scenario: "ac1",
      workspaceRoot: ws.root,
      runId: "run-a6c",
    });
    const file = path.join(ws.root, ".agent-runs", "run-a6c.json");
    await writeFile(file, "{ 这不是合法 JSON", "utf8");

    await expect(prepareResume({
      projectRoot: ws.root,
      runId: "run-a6c",
      digestFiles: DIGEST_FILES,
    })).rejects.toMatchObject({ code: "CHECKPOINT_CORRUPT" });

    // 入口行为一致：拒绝恢复、退出码 3。
    const child = await runScenarioInChild({
      scenario: "ac1",
      workspaceRoot: ws.root,
      mode: "resume",
      runId: "run-a6c",
    });
    expect(child.code).toBe(3);
  }, 90_000);

  it("任务已终结 → RUN_TERMINAL", async () => {
    const ws = await makeTempWorkspace("a6t-");
    await runScenarioInChild({
      scenario: "ac4",
      workspaceRoot: ws.root,
      runId: "run-a6t",
    });
    // 手动把存档里的任务改成终态，并重算校验和。
    const file = path.join(ws.root, ".agent-runs", "run-a6t.json");
    const raw = JSON.parse(await readFile(file, "utf8"));
    raw.payload.task.status = "cancelled";
    const stable = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
      if (value && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => a.localeCompare(b));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
      }
      return JSON.stringify(value) ?? "null";
    };
    raw.checksum = createHash("sha256").update(stable(raw.payload)).digest("hex");
    await writeFile(file, JSON.stringify(raw), "utf8");

    await expect(prepareResume({
      projectRoot: ws.root,
      runId: "run-a6t",
      digestFiles: DIGEST_FILES,
    })).rejects.toMatchObject({ code: "RUN_TERMINAL" });
  }, 90_000);
});

describe("A7 多次工具失败后暂停，恢复后保留失败记录、计数和预算", () => {
  it("暂停不是失败，失败历史与预算不回退", async () => {
    const ws = await makeTempWorkspace("a7-");
    const child = await runScenarioInChild({
      scenario: "ac7",
      workspaceRoot: ws.root,
      runId: "run-a7",
    });
    expect(child.code).toBe(0);

    const env = await loadCheckpoint(ws.root, "run-a7");
    const reproduce = env.payload.task.steps.find((s) => s.stepId === "reproduce");
    expect(reproduce?.failures.length).toBeGreaterThan(0);
    expect(reproduce?.toolCalls.filter((c) => c.toolName === "run_test").length)
      .toBeGreaterThanOrEqual(2);
    expect(env.payload.task.counters.toolCalls).toBeGreaterThan(0);

    // 暂停不是失败：状态不得是 failed。
    expect(["suspended", "running"]).toContain(env.payload.task.status);

    const resumed = await prepareResume({
      projectRoot: ws.root,
      runId: "run-a7",
      digestFiles: DIGEST_FILES,
    });
    expect(resumed.task.counters.toolCalls).toBe(env.payload.task.counters.toolCalls);
    expect(resumed.task.steps.find((s) => s.stepId === "reproduce")?.failures.length)
      .toBe(reproduce?.failures.length);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// 场景一：中断之后，能不能接上原来的进度
// ---------------------------------------------------------------------------
describe("A8 场景一：--pause-after 优雅暂停后跨进程恢复", () => {
  it("暂停时诊断完成、补丁未执行、任务未终结，恢复后接上原进度并跑完", async () => {
    const ws = await makeTempWorkspace("a8-");
    const paused = await runScenarioInChild({
      scenario: "ac_full",
      workspaceRoot: ws.root,
      runId: "run-lab",
      pauseAfter: 6,
      autoApprove: true,
    });
    // 暂停不是崩溃：进程正常退出。
    expect(paused.code).toBe(0);
    const pausedOut = paused.result;
    expect(pausedOut.stopCode).toBe("INTERRUPTED");
    expect(pausedOut.turn).toBe(6);
    // 只是暂停，没有失败，也没有终结。
    expect(pausedOut.recordStatus).toBe("running");
    expect(pausedOut.revision).toBe("r0");
    // 诊断已完成、补丁尚未执行：这正是原稿要观察的那一幕。
    const pausedSteps = pausedOut.planSteps as { id: string; status: string }[];
    expect(pausedSteps.find((s) => s.id === "read")?.status).toBe("completed");
    expect(pausedSteps.find((s) => s.id === "reproduce")?.status).toBe("completed");
    expect(pausedSteps.find((s) => s.id === "fix")?.status).toBe("pending");
    expect(await patchCount(ws)).toBe(0);

    // 存档已落盘，且能被判定为"可以续跑"。
    const before = await loadCheckpoint(ws.root, "run-lab");
    expect(before.payload.task.status).toBe("running");
    expect(before.payload.task.counters.turn).toBe(6);
    expect(before.payload.plan?.steps.find((s) => s.id === "read")?.status)
      .toBe("completed");
    const resumePoint = await prepareResume({
      projectRoot: ws.root,
      runId: "run-lab",
      digestFiles: DIGEST_FILES,
    });
    expect(resumePoint.inspection.canResume).toBe(true);
    const evidenceBefore = before.payload.evidence.map((item) => item.id);
    // 暂停点必须把会话历史留在存档里：这是"恢复到上一次的上下文"的唯一依据。
    // （曾经这里是空的——persist 写的是 context.messages，而 pi 的 Loop 不回写它。）
    const historyBefore = before.payload.session.messages;
    expect(historyBefore.length).toBeGreaterThan(0);
    expect(historyBefore.some((message) => message.role === "assistant")).toBe(true);

    // 恢复：接上原任务，而不是重做一遍。
    const resumed = await runScenarioInChild({
      scenario: "ac_full",
      workspaceRoot: ws.root,
      mode: "resume",
      runId: "run-lab",
      autoApprove: true,
    });
    expect(resumed.code).toBe(0);
    const out = resumed.result;
    expect(out.stopCode).toBe("COMPLETED");
    // 恢复走 pi 的续跑入口：回灌已有会话历史，而不是把任务输入再发一遍。
    expect(out.resumeEntry).toBe("continue");
    // 还是原任务：标识、计划、已有证据、运行计数都在。
    expect(out.resumedFrom.runId).toBe("run-lab");
    expect(out.resumedFrom.turn).toBe(6);
    expect(out.resumedFrom.planVersion).toBe(1);
    expect(out.resumedFrom.evidence).toBe(before.payload.evidence.length);
    expect(out.resumedFrom.toolCalls).toBe(before.payload.task.counters.toolCalls);
    // 迁移记录接着旧编号继续，并留下恢复标记。
    const archiveTransitionCount = before.payload.task.transitions.length;
    const resumedTransitions = (out.transitions as { seq: number; event: string }[])
      .slice(archiveTransitionCount);
    expect(resumedTransitions[0]).toMatchObject({
      seq: archiveTransitionCount + 1,
      event: "task_resumed",
      from: "running",
      to: "running",
    });

    // 完成之后：三组测试都真跑过且 exit=0，交付物落地，证据无重号。
    const after = await loadCheckpoint(ws.root, "run-lab");
    const testCalls = after.payload.task.steps
      .flatMap((step) => step.toolCalls)
      .filter((call) => call.toolName === "run_test");
    const exits = testCalls.map((call) => {
      const payload = (call.output?.evidence as { payload?: { exitCode?: number } })
        ?.payload;
      return payload?.exitCode;
    });
    expect(exits).toEqual([1, 1, 0, 0, 0]);
    expect(await readFile(
      path.join(ws.root, "artifacts", "login-fix.md"),
      "utf8",
    )).toContain("根因");
    const evidenceIds = after.payload.evidence.map((item) => item.id);
    expect(new Set(evidenceIds).size).toBe(evidenceIds.length);
    for (const id of evidenceBefore) expect(evidenceIds).toContain(id);

    // 会话历史是累积的：暂停前的历史原样留在前面，恢复新增的接在后面。
    const historyAfter = after.payload.session.messages;
    expect(historyAfter.length).toBeGreaterThan(historyBefore.length);
    expect(historyAfter.slice(0, historyBefore.length).map((item) => item.role))
      .toEqual(historyBefore.map((item) => item.role));
    // 任务输入只出现一次：走 runAgentLoop 重发任务输入的话会多出第二条。
    const taskInputs = historyAfter.filter(
      (item) => item.role === "user" && JSON.stringify(item.content).includes("修复登录模块"),
    );
    expect(taskInputs).toHaveLength(1);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 场景二：人工批准之前，补丁能不能被拦住
// ---------------------------------------------------------------------------
describe("A9 场景二：人工审批拦住补丁", () => {
  it("不批准就停在 waiting_approval：证据保留、补丁完整、源码未被修改", async () => {
    const ws = await makeTempWorkspace("a9-");
    const before = await sourceOf(ws);
    const staged = await runScenarioInChild({
      scenario: "ac4",
      workspaceRoot: ws.root,
      runId: "run-fix",
      taskPrompt: "修复登录模块的会话过期边界问题",
    });
    expect(staged.code).toBe(0);
    const out = staged.result;
    expect(out.stopCode).toBe("WAITING_APPROVAL");
    expect(out.recordStatus).toBe("waiting_approval");
    expect(out.revision).toBe("r0");
    // 第一：前面的诊断与证据都保留。
    expect(out.planSteps.find((s: { id: string }) => s.id === "read").status)
      .toBe("completed");
    expect(out.planSteps.find((s: { id: string }) => s.id === "reproduce").status)
      .toBe("completed");
    expect(out.evidenceIds.length).toBeGreaterThan(0);
    // 第二：待确认的是具体补丁，不是省略号。
    const pending = out.pendingPatch as { args: { path: string; search: string; replace: string } };
    expect(pending.args.path).toBe(SOURCE);
    expect(pending.args.search).toBe(PATCH_SEARCH);
    expect(pending.args.replace).toContain(PATCH_RESULT);
    // 第三：最关键的一条——文件有没有提前被修改。
    expect(await sourceOf(ws)).toBe(before);

    // 没有决定就恢复：只报告、不启动模型。
    const undecided = await runScenarioInChild({
      scenario: "ac4",
      workspaceRoot: ws.root,
      mode: "resume",
      runId: "run-fix",
    });
    expect(undecided.code).toBe(0);
    expect(undecided.result.result).toBeUndefined();
    expect(undecided.stdout).toContain("待人工确认");
    expect(await sourceOf(ws)).toBe(before);

    // 批准：执行的必须就是批准的那一份。
    const approved = await runScenarioInChild({
      scenario: "ac4",
      workspaceRoot: ws.root,
      mode: "resume",
      runId: "run-fix",
      decision: "approve",
    });
    expect(approved.code).toBe(0);
    const approvedOut = approved.result;
    expect(approvedOut.stopCode).toBe("COMPLETED");
    expect(approvedOut.decisionsBy).toEqual({ manual: 1, auto: 0 });
    expect(approvedOut.decisions[0].hash).toBe(pendingHash(undecided.result));
    expect(await patchCount(ws)).toBe(1);
    expect(await sourceOf(ws)).toContain(`return ${PATCH_RESULT}`);
  }, 120_000);

  it("拒绝之后补丁不落盘，任务停在 suspended 而不是 failed", async () => {
    const ws = await makeTempWorkspace("a9r-");
    const before = await sourceOf(ws);
    await runScenarioInChild({
      scenario: "ac4",
      workspaceRoot: ws.root,
      runId: "run-rej",
    });

    const rejected = await runScenarioInChild({
      scenario: "ac4",
      workspaceRoot: ws.root,
      mode: "resume",
      runId: "run-rej",
      decision: "reject",
    });
    expect(rejected.code).toBe(0);
    expect(rejected.result.stopCode).toBe("APPROVAL_REJECTED");
    expect(rejected.result.recordStatus).toBe("suspended");
    expect(rejected.result.decisionsBy).toEqual({ manual: 1, auto: 0 });
    expect(await sourceOf(ws)).toBe(before);

    // 被拒绝的待审批动作已经清掉，不会被下一次恢复拿去执行。
    const env = await loadCheckpoint(ws.root, "run-rej");
    expect(env.payload.task.pendingApproval).toBeUndefined();
    expect(await patchCount(ws)).toBe(0);
  }, 120_000);

  it("--auto-approve 不绕过审批：仍走暂存与落盘校验，只把来源记成 auto", async () => {
    const ws = await makeTempWorkspace("a9a-");
    const child = await runScenarioInChild({
      scenario: "ac_full",
      workspaceRoot: ws.root,
      runId: "run-auto",
      autoApprove: true,
    });
    expect(child.code).toBe(0);
    const out = child.result;
    expect(out.stopCode).toBe("COMPLETED");
    expect(out.decisionsBy).toEqual({ manual: 0, auto: 1 });
    expect(out.transitions.some(
      (item: { event: string }) => item.event === "approval_requested",
    )).toBe(true);
    expect(out.transitions.some(
      (item: { event: string }) => item.event === "approval_granted",
    )).toBe(true);
    expect(await patchCount(ws)).toBe(1);
  }, 120_000);
});

function pendingHash(result: Record<string, any>): string {
  return result.pendingApprovalInArchive?.patchHash ?? "";
}

// ---------------------------------------------------------------------------
// 场景三：失败以后，能不能留下可对照的证据
// ---------------------------------------------------------------------------
describe("A10 场景三：独立工作区重跑", () => {
  it("原记录不被覆盖，新运行独立可查，两次结果能对照，且不继承原权限", async () => {
    const ws = await makeTempWorkspace("a10-");
    // 原运行：一次失败的修复尝试（补丁停在被拒绝之后）。
    await runScenarioInChild({
      scenario: "ac4",
      workspaceRoot: ws.root,
      runId: "run-bad",
    });
    await runScenarioInChild({
      scenario: "ac4",
      workspaceRoot: ws.root,
      mode: "resume",
      runId: "run-bad",
      decision: "reject",
    });

    const originalFile = path.join(ws.root, ".agent-runs", "run-bad.json");
    const originalBytes = await readFile(originalFile, "utf8");

    // 重跑：不带 --auto-approve，也不带任何批准决定。
    const replay = await runScenarioInChild({
      scenario: "ac4",
      workspaceRoot: ws.root,
      mode: "replay",
      runId: "run-bad",
    });
    expect(replay.code).toBe(0);
    const out = replay.result;
    // 新运行有独立的工作区与 runId。
    expect(out.workspace).not.toBe(ws.root);
    expect(out.workspace).toContain("agent-rerun-");
    expect(out.replay.sourceRunId).toBe("run-bad");
    expect(out.replay.workspaceRoot).toBe(out.workspace);
    expect(out.replay.dangerousPermissions).toBe(false);
    // 原存档字节级不变，新运行自己写自己的记录。
    expect(await readFile(originalFile, "utf8")).toBe(originalBytes);
    // 不继承危险操作权限：新运行照样停在等待审批，源码是初始代码。
    expect(out.stopCode).toBe("WAITING_APPROVAL");
    expect(out.decisionsBy).toEqual({ manual: 0, auto: 0 });
    const freshSource = await readFile(
      path.join(out.workspace, "repo", SOURCE),
      "utf8",
    );
    expect(freshSource).toContain("return expiresOn < currentDay;");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// A11   可反复执行：新运行不得顶掉同 runId 的未终结存档
// ---------------------------------------------------------------------------
describe("A11 同 runId 的新运行拒绝覆盖未终结存档", () => {
  it("暂停后再次新运行 → 退出码 3、原存档字节不变；换 runId 重开、--resume 续跑都不受影响", async () => {
    const ws = await makeTempWorkspace("a11-");
    const paused = await runScenarioInChild({
      scenario: "ac_full",
      workspaceRoot: ws.root,
      runId: "run-rep",
      pauseAfter: 6,
      autoApprove: true,
    });
    expect(paused.code).toBe(0);

    const archive = path.join(ws.root, ".agent-runs", "run-rep.json");
    const bytes = await readFile(archive, "utf8");

    // 不带 --resume 再跑一次 = 从头再跑一遍，它会顶掉暂停中的存档，必须被拒绝。
    const clobber = await runScenarioInChild({
      scenario: "ac_full",
      workspaceRoot: ws.root,
      runId: "run-rep",
      autoApprove: true,
    });
    expect(clobber.code).toBe(3);
    expect(clobber.stderr).toContain("还有未终结的存档");
    expect(clobber.stderr).toContain("--resume run-rep");
    // 拒绝得彻底：模型没跑、存档一个字节都没动。
    expect(clobber.result.result).toBeUndefined();
    expect(await readFile(archive, "utf8")).toBe(bytes);

    // 换一个 runId 就能重新开始：旧存档照样原样保留。
    const other = await runScenarioInChild({
      scenario: "ac_full",
      workspaceRoot: ws.root,
      runId: "run-rep-2",
      pauseAfter: 6,
      autoApprove: true,
    });
    expect(other.code).toBe(0);
    expect(await readFile(archive, "utf8")).toBe(bytes);

    // 拒绝覆盖不影响恢复路径：原存档仍然可以续跑。
    const resumed = await runScenarioInChild({
      scenario: "ac_full",
      workspaceRoot: ws.root,
      mode: "resume",
      runId: "run-rep",
      autoApprove: true,
    });
    expect(resumed.code).toBe(0);
    expect(resumed.result.stopCode).toBe("COMPLETED");
  }, 180_000);
});
