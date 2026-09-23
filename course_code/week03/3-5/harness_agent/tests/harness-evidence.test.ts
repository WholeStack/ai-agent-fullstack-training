import { appendFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { AfterToolCallContext, ShouldStopAfterTurnContext } from "@earendil-works/pi-agent-core";

import { createLoginFixContract } from "../src/completion-contract.js";
import { LoopGuard, type LoopState } from "../src/loop-guard.js";
import { PlanningSession } from "../src/plan-store.js";
import { createExecutionContext } from "../src/run-context.js";
import { DemoToolRuntime, type ManagedToolResult } from "../src/runtime.js";
import { makeTempWorkspace, PATCH_REPLACE, PATCH_SEARCH, PROJECT_ROOT } from "./support/harness.js";

const workspaces: string[] = [];
const SCOPES = ["target", "boundary", "regression"] as const;
const REPORT = [
  "# 登录会话到期修复",
  "根因：原实现只比较 UTC 日期，忽略到期时刻。",
  "改动：改为精确时间戳比较，到期瞬间即失效。",
  "验证命令：node --import tsx --test <repo>/tests/{session-policy,session-boundary,login-flow}.test.ts。",
  "结果：target、boundary、regression 全部退出 0。",
  "未验证项：生产环境、浏览器端到端未运行。",
].join("\n\n");

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function prepare() {
  const workspace = await makeTempWorkspace("harness-evidence-");
  workspaces.push(workspace.root);
  const runtimeRoot = path.join(workspace.root, "runner");
  await mkdir(runtimeRoot);
  await symlink(path.join(PROJECT_ROOT, "node_modules"), path.join(runtimeRoot, "node_modules"), "dir");
  await writeFile(path.join(runtimeRoot, "package.json"), '{"type":"module"}');
  await writeFile(path.join(runtimeRoot, "tsconfig.json"), '{"compilerOptions":{"target":"ES2024"}}');
  const context = createExecutionContext({
    projectRoot: workspace.root,
    repoRoot: workspace.repoRoot,
    artifactRoot: workspace.artifactRoot,
    runtimeRoot,
  });
  const runtime = new DemoToolRuntime();
  const session = new PlanningSession({ getRevision: () => runtime.getRevision() });
  const plan = session.createPlan({
    goal: "修复并验证会话到期边界",
    steps: [{ id: "work", objective: "完成修复验证与报告", dependsOn: [], successCriteria: ["真实交付"] }],
  });
  plan.ensureActive("work");
  const state: LoopState = {
    runId: "evidence", turn: 1, maxTurns: 10, actions: new Map(),
    evidence: { readFiles: new Set(), writtenArtifacts: new Set() },
  };
  const guard = new LoopGuard(state, {
    session,
    contract: createLoginFixContract(context),
    getRevision: () => runtime.getRevision(),
    getCompletionState: () => runtime.captureCompletionState(context),
  });
  let sequence = 0;
  async function invoke(modelName: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const toolCallId = `call-${++sequence}`;
    const result = await runtime.invoke({ modelName, args, signal, toolCallId, context });
    observe(toolCallId, modelName, args, result);
    return result;
  }
  function observe(id: string, name: string, args: Record<string, unknown>, result: ManagedToolResult) {
    guard.observeToolResult({
      toolCall: { id, name, arguments: args },
      args: { ...args, planStepId: "work" },
      isError: !result.ok,
      result: { content: [{ type: "text", text: JSON.stringify(result.modelView) }], details: result },
    } as AfterToolCallContext);
  }
  async function ready() {
    expect((await invoke("apply_patch", {
      path: context.targetSource, search: PATCH_SEARCH, replace: PATCH_REPLACE,
    })).ok).toBe(true);
    for (const scope of SCOPES) {
      const result = await invoke("run_test", { scope });
      expect(result.evidence?.payload.passed).toBe(true);
    }
    await invoke("write_file", { path: context.targetArtifact, content: REPORT });
    plan.complete("work", session.evidence.list().map((item) => item.id));
    expect(await guard.verifyCompletion()).toEqual([]);
  }
  return { context, runtime, session, guard, state, invoke, ready };
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await readFile(file);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() > deadline) throw error;
      await delay(10);
    }
  }
}

const endTurn = { toolResults: [] } as unknown as ShouldStopAfterTurnContext;

describe("Harness 当前内容与完成证据", () => {
  it.each([
    ["源码", "repo", "src/services/auth-service.ts"],
    ["测试", "repo", "tests/session-boundary.test.ts"],
    ["仓库配置", "repo", "tsconfig.json"],
    ["执行器配置", "runtime", "tsconfig.json"],
  ])("三组通过后外部修改%s，不能完成并反馈各范围重验", async (_label, root, relative) => {
    const h = await prepare();
    await h.ready();
    await appendFile(path.join(root === "repo" ? h.context.repoRoot : h.context.runtimeRoot, relative), "\n// changed externally\n");
    expect(h.runtime.getRevision()).toBe("r1");
    expect(await h.guard.afterTurn(endTurn)).toBe(false);
    expect(h.state.stopCode).not.toBe("COMPLETED");
    const followUps = JSON.stringify(h.guard.drainFollowUps());
    for (const scope of SCOPES) expect(followUps).toContain(scope);
  });

  it("同内容同范围后一次失败覆盖旧通过，重新通过才能完成", async () => {
    const h = await prepare();
    const marker = path.join(h.context.projectRoot, "fail-boundary");
    await appendFile(path.join(h.context.repoRoot, h.context.boundarySuite.files[0]), `\nimport { existsSync } from "node:fs";\ntest("受控外部依赖", () => assert.equal(existsSync(${JSON.stringify(marker)}), false));\n`);
    await h.ready();
    const original = await h.runtime.captureCompletionState(h.context);
    await writeFile(marker, "fail");
    const failed = await h.invoke("run_test", { scope: "boundary" });
    expect(failed.evidence?.payload.exitCode).toBe(1);
    expect((await h.runtime.captureCompletionState(h.context)).verificationDigest).toBe(original.verificationDigest);
    expect(await h.guard.verifyCompletion()).toEqual([
      expect.stringContaining("boundary"),
    ]);
    expect(await h.guard.afterTurn(endTurn)).toBe(false);
    await rm(marker);
    expect((await h.invoke("run_test", { scope: "boundary" })).evidence?.payload.passed).toBe(true);
    expect(await h.guard.afterTurn(endTurn)).toBe(true);
    expect(h.state.stopCode).toBe("COMPLETED");
  });

  it("测试期间修改后即使退出0也不能作为验证依据", async () => {
    const h = await prepare();
    const started = path.join(h.context.projectRoot, "test-started");
    const release = path.join(h.context.projectRoot, "test-release");
    await appendFile(path.join(h.context.repoRoot, h.context.boundarySuite.files[0]), `\nimport { existsSync, writeFileSync } from "node:fs";\nimport { setTimeout as pause } from "node:timers/promises";\ntest("等候外部编辑", async () => { writeFileSync(${JSON.stringify(started)}, "ready"); while (!existsSync(${JSON.stringify(release)})) await pause(10); });\n`);
    await h.invoke("apply_patch", { path: h.context.targetSource, search: PATCH_SEARCH, replace: PATCH_REPLACE });
    const controller = new AbortController();
    const running = h.invoke("run_test", { scope: "boundary" }, controller.signal);
    let result: ManagedToolResult;
    try {
      await waitForFile(started);
      await appendFile(path.join(h.context.repoRoot, h.context.targetSource), "\n// changed during test\n");
      await writeFile(release, "continue");
      result = await running;
    } finally {
      controller.abort();
      await running;
    }
    expect(result.evidence?.payload.exitCode).toBe(0);
    expect(result.code).toBe("TEST_INPUT_CHANGED");
    expect(result.evidence?.payload.passed).toBe(false);
    expect(await h.guard.afterTurn(endTurn)).toBe(false);
    expect(JSON.stringify(h.guard.drainFollowUps())).toContain("TEST_INPUT_CHANGED");
  });

  it.each(["删除", "改写"])("交付报告%s后不能凭旧写入记录完成", async (change) => {
    const h = await prepare();
    await h.ready();
    const artifact = path.join(h.context.projectRoot, h.context.targetArtifact);
    if (change === "删除") await rm(artifact);
    else await writeFile(artifact, "# 一个不再对应交付记录的报告");
    const missing = await h.guard.verifyCompletion();
    expect(missing).toEqual([expect.stringContaining(h.context.targetArtifact)]);
    expect(await h.guard.afterTurn(endTurn)).toBe(false);
    await h.invoke("write_file", { path: h.context.targetArtifact, content: REPORT });
    expect(await h.guard.afterTurn(endTurn)).toBe(true);
  });

  it("外部改回缺陷后重跑测试不能沿用旧diff，即使假测试通过", async () => {
    const h = await prepare();
    await h.ready();
    const sourcePath = path.join(h.context.repoRoot, h.context.targetSource);
    await writeFile(sourcePath, (await readFile(sourcePath, "utf8")).replace(PATCH_REPLACE, PATCH_SEARCH));
    for (const suite of [h.context.targetSuite, h.context.boundarySuite, h.context.regressionSuite]) {
      for (const file of suite.files) await writeFile(path.join(h.context.repoRoot, file), 'import test from "node:test"; test("不完整检查", () => {});');
    }
    for (const scope of SCOPES) expect((await h.invoke("run_test", { scope })).evidence?.payload.passed).toBe(true);
    expect(await h.guard.verifyCompletion()).toEqual([expect.stringContaining(h.context.targetSource)]);
    expect(await h.guard.afterTurn(endTurn)).toBe(false);
  });

  it.each(["cancelled", "unknown"])("最近的%s测试结果保留为证据并阻挡更早通过", async (mode) => {
    const h = await prepare();
    const marker = path.join(h.context.projectRoot, "interrupt-boundary");
    const started = path.join(h.context.projectRoot, "interrupt-started");
    await appendFile(path.join(h.context.repoRoot, h.context.boundarySuite.files[0]), `\nimport { existsSync, writeFileSync } from "node:fs";\nimport { setTimeout as pause } from "node:timers/promises";\ntest("可中断检查", async () => { if (existsSync(${JSON.stringify(marker)})) { writeFileSync(${JSON.stringify(started)}, "ready"); await pause(30000); } });\n`);
    await h.ready();
    let result: ManagedToolResult;
    if (mode === "cancelled") {
      await writeFile(marker, "interrupt");
      const controller = new AbortController();
      const running = h.invoke("run_test", { scope: "boundary" }, controller.signal);
      try {
        await waitForFile(started);
      } finally {
        controller.abort();
        result = await running;
      }
      expect(result.code).toBe("ABORTED");
    } else {
      await rm(path.join(h.context.runtimeRoot, "node_modules"));
      // 启动输入核对失败也是最新未知结果，不允许跳过后沿用通过。
      await rm(h.context.runtimeRoot, { recursive: true });
      result = await h.invoke("run_test", { scope: "boundary" });
      await mkdir(h.context.runtimeRoot);
      await symlink(path.join(PROJECT_ROOT, "node_modules"), path.join(h.context.runtimeRoot, "node_modules"), "dir");
      await writeFile(path.join(h.context.runtimeRoot, "package.json"), '{"type":"module"}');
      await writeFile(path.join(h.context.runtimeRoot, "tsconfig.json"), '{"compilerOptions":{"target":"ES2024"}}');
      expect(result.code).toBe("TEST_RESULT_UNKNOWN");
    }
    expect(h.session.evidence.list().findLast((item) => item.kind === "test")?.payload.passed).toBe(false);
    expect(await h.guard.verifyCompletion()).toEqual([expect.stringContaining("boundary")]);
    expect(await h.guard.afterTurn(endTurn)).toBe(false);
    expect(h.state.stopCode).not.toBe("COMPLETED");
  });
});
