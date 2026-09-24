import { readFile, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Context } from "@earendil-works/pi-ai";
import { runPlanningAgent } from "../src/agent-runner.js";
import { ApprovalGate } from "../src/approval.js";
import { applyApprovedPatch } from "../src/approval-flow.js";
import { computeRepoDigest, loadCheckpoint, saveCheckpoint } from "../src/checkpoint.js";
import { runCli } from "../src/cli.js";
import { PlanningSession } from "../src/plan-store.js";
import { createExecutionContext } from "../src/run-context.js";
import { DemoToolRuntime } from "../src/runtime.js";
import { prepareResume } from "../src/resume.js";
import { TaskRecorder } from "../src/task-record.js";
import { makeTempWorkspace, PATCH_REPLACE, PATCH_SEARCH, PROJECT_ROOT } from "./support/harness.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace() {
  const work = await makeTempWorkspace("lifecycle-");
  roots.push(work.root);
  return createExecutionContext({ projectRoot: work.root, repoRoot: work.repoRoot, runtimeRoot: PROJECT_ROOT });
}

function call(name: string, args: Record<string, unknown>) {
  return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
}

function recorder(runId = "lifecycle"): TaskRecorder {
  return new TaskRecorder({
    runId, taskInput: "修复到期边界", steps: ["fix"],
    counters: { turn: 0, maxTurns: 20, toolCalls: 0, maxToolCalls: 50, revisions: 0, maxRevisions: 2, checkpoints: 0 },
  });
}

const plan = {
  goal: "修复到期边界",
  steps: [{ id: "fix", objective: "修复到期判断", dependsOn: [], successCriteria: ["补丁已落盘"] }],
};

const patch = {
  path: "src/auth/session-policy.ts", search: PATCH_SEARCH, replace: PATCH_REPLACE, planStepId: "fix",
};

describe("lifecycle cancellation and resume boundaries", () => {
  it("rejects stale approval without changing the externally edited file", async () => {
    const context = await workspace();
    const runtime = new DemoToolRuntime();
    const approval = new ApprovalGate();
    const session = new PlanningSession({ getRevision: () => runtime.getRevision() });
    const record = recorder();
    const staged = approval.stage({ plan: { ...patch, ...await runtime.planPatch({ ...patch, context }) }, stepId: "fix" });
    record.stageApproval(staged);
    const filename = path.join(context.repoRoot, context.targetSource);
    const edited = `${await readFile(filename, "utf8")}\n// external edit\n`;
    await writeFile(filename, edited);
    await expect(applyApprovedPatch({ approval, runtime, session, recorder: record, context }, {
      actionId: staged.actionId, by: "manual",
    })).rejects.toMatchObject({ code: "APPROVAL_STALE" });
    expect(await readFile(filename, "utf8")).toBe(edited);
    expect(record.pendingApproval?.approved).toBe(false);
    expect(session.evidence.list()).toEqual([]);
  });

  it("checks approval signal before commit and records a write completed just before cancellation", async () => {
    const context = await workspace();
    const runtime = new DemoToolRuntime();
    const approval = new ApprovalGate();
    const session = new PlanningSession({ getRevision: () => runtime.getRevision() });
    const record = recorder();
    const staged = approval.stage({ plan: { ...patch, ...await runtime.planPatch({ ...patch, context }) }, stepId: "fix" });
    record.stageApproval(staged);
    const controller = new AbortController();
    controller.abort();
    await expect(applyApprovedPatch({ approval, runtime, session, recorder: record, context }, {
      actionId: staged.actionId, by: "manual", signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(await readFile(path.join(context.repoRoot, context.targetSource), "utf8")).toContain(PATCH_SEARCH);
    const afterWrite = new AbortController();
    const result = await applyApprovedPatch({ approval, runtime, session, recorder: record, context }, {
      actionId: staged.actionId, by: "manual", signal: afterWrite.signal,
      onAfterCommit: async () => { afterWrite.abort(); },
    });
    expect(result.ok).toBe(true);
    expect(await readFile(path.join(context.repoRoot, context.targetSource), "utf8")).toContain(PATCH_REPLACE);
    expect(record.pendingApproval).toBeUndefined();
    expect(record.step("fix").toolCalls.at(-1)).toMatchObject({ ok: true, endedAt: expect.any(Number) });
  });

  it("persists successful patch progress after cancelling a real running test, with no surviving child", async () => {
    const executionContext = await workspace();
    const pidFile = path.join(executionContext.projectRoot, "test-child.pid");
    const slowTest = path.join(executionContext.repoRoot, executionContext.targetSuite.files[0]);
    // A real OS process is required: fake clocks cannot exercise process-group signal delivery.
    await writeFile(slowTest, `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.once('message', () => writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)));
      setInterval(() => {}, 1000);
    `);
    const controller = new AbortController();
    const ready = new Promise<void>((resolve) => {
      const watcher = watch(executionContext.projectRoot, (_event, filename) => {
        if (filename === "test-child.pid") {
          watcher.close();
          controller.abort();
          resolve();
        }
      });
      controller.signal.addEventListener("abort", () => watcher.close(), { once: true });
    });
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    faux.setResponses([call("create_plan", plan), call("apply_patch", patch), call("run_test", { scope: "target", planStepId: "fix" })]);
    let result;
    try {
      result = await runPlanningAgent({
        model: faux.getModel(), streamFn: faux.provider.streamSimple, executionContext,
        autoApprove: true, signal: controller.signal,
      });
      await ready;
    } finally {
      controller.abort();
    }
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(result.record.status).toBe("cancelled");
    expect(result.runtime.getRevision()).toBe("r1");
    expect(await readFile(path.join(executionContext.repoRoot, executionContext.targetSource), "utf8")).toContain(PATCH_REPLACE);
    const archived = await loadCheckpoint(executionContext.projectRoot, result.state.runId);
    expect(archived.payload.task.status).toBe("cancelled");
    const test = archived.payload.evidence.findLast((item) => item.kind === "test");
    expect(test?.payload).toMatchObject({ passed: false, cancelled: true });
    expect(archived.payload.evidence.some((item) => item.kind === "diff")).toBe(true);
  }, 15_000);

  it("sends actual parameter and preflight errors back to the next model turn and the checkpoint record", async () => {
    const executionContext = await workspace();
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    faux.setResponses([
      call("create_plan", plan),
      call("run_test", { scope: "invalid", planStepId: "fix" }),
      call("apply_patch", { ...patch, planStepId: "not-ready" }),
      fauxAssistantMessage("已修复", { stopReason: "stop" }),
    ]);
    const contexts: Context[] = [];
    const result = await runPlanningAgent({
      model: faux.getModel(), executionContext, maxTurns: 4,
      streamFn: (model, context, options) => {
        contexts.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) });
        return faux.provider.streamSimple(model, context, options);
      },
    });
    const errors = result.record.steps.flatMap((step) => step.toolCalls).filter((item) => !item.ok);
    expect(errors.map((item) => item.toolName)).toEqual(["run_test", "apply_patch"]);
    for (const failed of errors) {
      expect(failed.endedAt).toEqual(expect.any(Number));
      expect(contexts.at(-1)?.messages.some((message) => message.role === "toolResult"
        && message.toolCallId === failed.toolCallId && message.isError)).toBe(true);
    }
    expect(errors[1].failureReason).toContain("PLAN_STEP_NOT_READY");
    expect(await readFile(path.join(executionContext.repoRoot, executionContext.targetSource), "utf8")).toContain(PATCH_SEARCH);
  });

  it("resumes from saved progress without repeating the committed patch and preserves running pause status", async () => {
    const executionContext = await workspace();
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    faux.setResponses([call("create_plan", plan), call("apply_patch", patch)]);
    const paused = await runPlanningAgent({
      model: faux.getModel(), streamFn: faux.provider.streamSimple, executionContext,
      autoApprove: true, pauseAfter: 2,
    });
    expect(paused.record.status).toBe("running");
    const saved = await prepareResume({ projectRoot: executionContext.projectRoot, runId: paused.state.runId });
    const before = await readFile(path.join(executionContext.repoRoot, executionContext.targetSource), "utf8");
    faux.setResponses([call("get_plan", {})]);
    const continued = await runPlanningAgent({
      model: faux.getModel(), streamFn: faux.provider.streamSimple, executionContext,
      restore: saved, pauseAfter: 3,
    });
    expect(continued.resumeEntry).toBe("continue");
    expect(continued.runtime.getRevision()).toBe("r1");
    expect(await readFile(path.join(executionContext.repoRoot, executionContext.targetSource), "utf8")).toBe(before);
    expect(continued.trace.some((event) => event.toolName === "apply_patch")).toBe(false);
  });

  it("does not refill a deleted source file or construct the model before resume inspection", async () => {
    const executionContext = await workspace();
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    faux.setResponses([call("create_plan", plan)]);
    const paused = await runPlanningAgent({ model: faux.getModel(), streamFn: faux.provider.streamSimple, executionContext, pauseAfter: 1 });
    const filename = path.join(executionContext.repoRoot, executionContext.targetSource);
    await rm(filename);
    let created = false;
    const outcome = await runCli({
      argv: ["--workspace", executionContext.projectRoot, "--resume", paused.state.runId],
      createModel: () => { created = true; throw new Error("model must not be constructed"); },
      out: () => {}, err: () => {},
    });
    expect(outcome.exitCode).toBe(3);
    expect(created).toBe(false);
    await expect(readFile(filename)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not hide the latest interrupted test behind an earlier pass, even for a completed recorded step", async () => {
    const context = await workspace();
    const record = recorder("latest-test");
    record.beginToolCall({ toolCallId: "old", toolName: "run_test", args: { scope: "target" }, stepId: "fix" });
    record.endToolCall({ toolCallId: "old", ok: true, output: { evidence: { payload: { exitCode: 0, passed: true } } } });
    record.beginToolCall({ toolCallId: "new", toolName: "run_test", args: { scope: "target" }, stepId: "fix" });
    record.endToolCall({ toolCallId: "new", ok: false, output: { evidence: { payload: { exitCode: null, passed: false, cancelled: true } } } });
    record.completeStep("fix", []);
    const digestFiles = [context.targetSource];
    await saveCheckpoint({
      projectRoot: context.projectRoot, runId: record.runId, task: record.snapshot(), evidence: [], messages: [],
      workspace: {
        id: context.projectRoot, projectRoot: context.projectRoot, repoRoot: context.repoRoot, codeRevision: "r0", digestFiles,
        repoDigest: await computeRepoDigest(context.repoRoot, digestFiles),
      },
    });
    await expect(prepareResume({ projectRoot: context.projectRoot, runId: record.runId })).rejects.toMatchObject({ code: "RESULT_UNKNOWN" });
  });
});
