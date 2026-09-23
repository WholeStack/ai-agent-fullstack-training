// ============================================================================
// 脚本化实验入口（课堂用，仅测试与演示）
//
// 与真实入口 src/main.ts 共用 src/cli.ts：参数、暂停、审批、恢复、重跑
// 走的是同一套代码，区别只在"谁出下一个工具调用"——这里用 faux 模型
// 把响应序列写死，因此同样的实验可以反复做、结果可比。
//
// 参数：--scenario <name>（脚本序列）+ src/cli.ts 的全部参数。
// 输出：最后一行 RESULT_JSON:<摘要>，供验收脚本断言。
// ============================================================================

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";

import { runCli, type CliCommand, type CliOutcome } from "../src/cli.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const scenario = arg("scenario") ?? "ac1";
const workspaceRoot = arg("workspace");
if (!workspaceRoot) {
  throw new Error("脚本化入口需要 --workspace <dir>。");
}

// 除 --scenario <name> 之外全部交给 cli.ts：这里不复刻任何参数语义。
const rawArgv = process.argv.slice(2);
const cliArgv = rawArgv.filter(
  (token, index) => token !== "--scenario" && rawArgv[index - 1] !== "--scenario",
);

function tc(name: string, args: Record<string, unknown>) {
  return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
}
function fm(text: string) {
  return fauxAssistantMessage(text, { stopReason: "stop" });
}

const PATCH_SEARCH = [
  "  const expiresOn = session.expiresAt.slice(0, 10);",
  "  const currentDay = now.toISOString().slice(0, 10);",
  "  return expiresOn < currentDay;",
].join("\n");
const PATCH_REPLACE = "  return Date.parse(session.expiresAt) <= now.getTime();";

const STEPS = [
  { id: "read", objective: "读取实现", dependsOn: [], successCriteria: ["有阅读证据"] },
  { id: "reproduce", objective: "复现失败", dependsOn: ["read"], successCriteria: ["有测试证据"] },
  { id: "fix", objective: "修正到期判断", dependsOn: ["reproduce"], successCriteria: ["有改动证据"] },
  { id: "verify", objective: "边界通过", dependsOn: ["fix"], successCriteria: ["exit=0"] },
  { id: "report", objective: "交付说明", dependsOn: ["verify"], successCriteria: ["写入 artifacts/login-fix.md"] },
];

/**
 * 一条脚本化模型响应：既可以是一段写死的消息，也可以是一个响应函数。
 * faux provider 对函数形式会传入当轮上下文（含注入的计划快照），
 * completeStep 用它读取真实证据 ID。证据 ID 由计划层按产生顺序分配，
 * 恢复时还会接着旧计数继续，因此收尾动作绝不能写死 ev-N。
 */
type ScriptedResponse = FauxResponseStep;

/**
 * 从每轮注入的计划快照里取出某步骤的证据 ID。
 * 快照格式（见 renderPlanSnapshot）：
 *   - ev-3 [diff] 修改 src/auth/session-policy.ts（步骤 fix）
 * 只认归属该步骤的行，避免把别的步骤证据算进来。
 */
function evidenceIdsForStep(snapshot: string, stepId: string): string[] {
  const ids: string[] = [];
  for (const line of snapshot.split("\n")) {
    const id = /^\s*-\s*(ev-\d+)\s*\[/.exec(line)?.[1];
    if (!id) continue;
    if (!line.includes(`（步骤 ${stepId}）`)) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function completeStep(stepId: string): ScriptedResponse {
  return (context: { systemPrompt?: string }) => {
    const ids = evidenceIdsForStep(context?.systemPrompt ?? "", stepId);
    return tc("update_plan_step", { stepId, action: "complete", evidenceIds: ids });
  };
}

/** 三段式收尾：补丁已落盘之后，把 fix/verify/report 走完。 */
function finishAfterPatch(): ScriptedResponse[] {
  return [
    completeStep("fix"),
    tc("run_test", { scope: "target", planStepId: "verify" }),
    tc("run_test", { scope: "boundary", planStepId: "verify" }),
    tc("run_test", { scope: "regression", planStepId: "verify" }),
    completeStep("verify"),
    tc("write_file", {
      path: "artifacts/login-fix.md",
      content: "# 登录会话到期边界修复\n\n根因：只比较 UTC 日期，会话最多晚 24 小时失效。",
      planStepId: "report",
    }),
    completeStep("report"),
    fm("全链路完成。"),
  ];
}

/** A1：诊断完成后保存并退出；恢复后从后续步骤继续。 */
function ac1Responses(): ScriptedResponse[] {
  return [
    tc("create_plan", { goal: "修复登录到期边界", steps: STEPS }),
    tc("read_file", { path: "src/auth/session-policy.ts", planStepId: "read" }),
    completeStep("read"),
    // 诊断完成；此轮结束会保存存档。
    fm("诊断完成，等待后续。"),
  ];
}

function ac1ResumeResponses(): ScriptedResponse[] {
  return [
    tc("run_test", { scope: "target", planStepId: "reproduce" }),
    completeStep("reproduce"),
    fm("恢复后继续复现步骤。"),
  ];
}

/** A3：测试已启动但没有完整结果：首次失败后仍不把它标为完成。 */
function ac3Responses(): ScriptedResponse[] {
  return [
    tc("create_plan", { goal: "修复登录到期边界", steps: STEPS }),
    tc("read_file", { path: "src/auth/session-policy.ts", planStepId: "read" }),
    completeStep("read"),
    tc("run_test", { scope: "target", planStepId: "reproduce" }),
    fm("测试未通过，暂停。"),
  ];
}

/**
 * A4 / 场景二：补丁等待审批即停。
 * 补丁之后的 completeStep("fix") 会被审批门拦下，这正是"等待审批"的停止点；
 * 批准还是拒绝不在模型手里，由入口的 --approve / --reject 决定。
 */
function ac4Responses(): ScriptedResponse[] {
  return [
    tc("create_plan", { goal: "修复登录到期边界", steps: STEPS }),
    tc("read_file", { path: "src/auth/session-policy.ts", planStepId: "read" }),
    completeStep("read"),
    tc("run_test", { scope: "target", planStepId: "reproduce" }),
    completeStep("reproduce"),
    tc("apply_patch", {
      path: "src/auth/session-policy.ts",
      search: PATCH_SEARCH,
      replace: PATCH_REPLACE,
      planStepId: "fix",
    }),
    completeStep("fix"),
  ];
}

/** 批准之后续跑：补丁已经落盘，接着把 fix/verify/report 走完。 */
function ac4ResumeResponses(): ScriptedResponse[] {
  return finishAfterPatch();
}

/** A7：同一动作重复失败后暂停（测试真实失败，步骤保持进行中）。 */
function ac7Responses(): ScriptedResponse[] {
  return [
    tc("create_plan", { goal: "修复登录到期边界", steps: STEPS }),
    tc("read_file", { path: "src/auth/session-policy.ts", planStepId: "read" }),
    completeStep("read"),
    // 源码未修，target 测试会真实失败（exit=1），失败记录累积。
    tc("run_test", { scope: "target", planStepId: "reproduce" }),
    tc("run_test", { scope: "boundary", planStepId: "reproduce" }),
    tc("run_test", { scope: "regression", planStepId: "reproduce" }),
    fm("多次失败，暂停等待人工。"),
  ];
}

/**
 * 场景一（ac_full）：一轮一个阶段，第 N 轮结束时正好停在阶段边界。
 *   轮1 create_plan        轮2 read_file       轮3 read 收尾
 *   轮4 reproduce 目标测试  轮5 reproduce 边界测试  轮6 reproduce 收尾
 *   轮7 apply_patch        轮8 fix 收尾
 *   轮9-11 verify 三组测试  轮12 verify 收尾
 *   轮13 交付物            轮14 report 收尾
 *
 * 因此 --pause-after 6 停下来的现场是：诊断已完成、补丁尚未执行、代码版本 r0，
 * 与课堂原稿要观察的那一幕一致。
 */
function acFullResponses(): ScriptedResponse[] {
  return [
    tc("create_plan", { goal: "修复登录到期边界", steps: STEPS }),
    tc("read_file", { path: "src/auth/session-policy.ts", planStepId: "read" }),
    completeStep("read"),
    tc("run_test", { scope: "target", planStepId: "reproduce" }),
    tc("run_test", { scope: "boundary", planStepId: "reproduce" }),
    completeStep("reproduce"),
    tc("apply_patch", {
      path: "src/auth/session-policy.ts",
      search: PATCH_SEARCH,
      replace: PATCH_REPLACE,
      planStepId: "fix",
    }),
    ...finishAfterPatch(),
  ];
}

/**
 * 恢复后的续跑序列：从暂停点接上，不重做已经完成的步骤。
 * 暂停点落在补丁之前，所以恢复时第一件事就是提交补丁
 * （人工已批准，或 --auto-approve 放行），然后继续收尾。
 */
function acFullResumeResponses(): ScriptedResponse[] {
  return [
    tc("apply_patch", {
      path: "src/auth/session-policy.ts",
      search: PATCH_SEARCH,
      replace: PATCH_REPLACE,
      planStepId: "fix",
    }),
    ...finishAfterPatch(),
  ];
}

const FRESH_BUILDERS: Record<string, () => ScriptedResponse[]> = {
  ac1: ac1Responses,
  ac3: ac3Responses,
  ac4: ac4Responses,
  ac7: ac7Responses,
  ac_full: acFullResponses,
};

const RESUME_BUILDERS: Record<string, () => ScriptedResponse[]> = {
  ac1: ac1ResumeResponses,
  ac4: ac4ResumeResponses,
  ac_full: acFullResumeResponses,
};

const pendingResponses: ScriptedResponse[] = [];

const faux = fauxProvider({ tokensPerSecond: 10_000 });

function scriptFor(command: CliCommand): ScriptedResponse[] {
  const builders = command.mode === "resume" ? RESUME_BUILDERS : FRESH_BUILDERS;
  const build = builders[scenario] ?? ac1ResumeResponses;
  return build();
}

const outcome = await runCli({
  argv: cliArgv,
  out: (line) => process.stdout.write(`${line}\n`),
  createModel: (command) => {
    pendingResponses.splice(0, pendingResponses.length, ...scriptFor(command));
    faux.setResponses(pendingResponses);
    return {
      model: faux.getModel(),
      streamFn: faux.provider.streamSimple.bind(faux.provider),
    };
  },
});

/** 目标源码里是否已经出现修复后的判断——审批与重跑实验的最终判据。 */
async function fileContainsPatch(): Promise<boolean> {
  try {
    const source = await readFile(
      path.join(outcome.repoRoot ?? path.join(workspaceRoot!, "repo"), "src/auth/session-policy.ts"),
      "utf8",
    );
    return source.includes(PATCH_REPLACE.trim());
  } catch {
    return false;
  }
}

const output = await buildResultJson(outcome);
await writeFile(
  path.join(outcome.workspace ?? workspaceRoot, "last-result.json"),
  JSON.stringify(output, null, 2),
  "utf8",
);
console.log(`RESULT_JSON:${JSON.stringify(output)}`);
process.exit(outcome.exitCode);

async function buildResultJson(current: CliOutcome): Promise<Record<string, unknown>> {
  const output: Record<string, unknown> = {
    scenario,
    mode: current.command.mode,
    exitCode: current.exitCode,
    workspace: current.workspace,
    patched: await fileContainsPatch(),
  };
  const result = current.result;
  const inspection = current.inspection;

  if (inspection) {
    output.canResume = inspection.canResume;
    output.notes = inspection.notes;
    output.unresolved = inspection.unresolved;
    output.checkpointSeq = inspection.checkpoint.seq;
    output.resumedFrom = {
      runId: inspection.checkpoint.payload.task.runId,
      status: inspection.checkpoint.payload.task.status,
      revision: inspection.checkpoint.payload.workspace.codeRevision,
      turn: inspection.checkpoint.payload.task.counters.turn,
      toolCalls: inspection.checkpoint.payload.task.counters.toolCalls,
      evidence: inspection.checkpoint.payload.evidence.length,
      planVersion: inspection.checkpoint.payload.plan?.version ?? null,
      planSteps: inspection.checkpoint.payload.plan?.steps.map((step) => ({
        id: step.id,
        status: step.status,
      })) ?? [],
      transitions: inspection.checkpoint.payload.task.transitions.length,
    };
    output.pendingApprovalInArchive = inspection.pendingApproval ?? null;
    output.autoApprovedBefore = inspection.autoApproved;
  }

  if (current.replay) {
    output.replay = {
      sourceRunId: current.replay.sourceRunId,
      runId: current.replay.runId,
      workspaceRoot: current.replay.workspaceRoot,
      dangerousPermissions: current.replay.dangerousPermissions,
      originalTestSummary: current.replay.originalTestSummary,
    };
  }

  if (result) {
    output.stopCode = result.state.stopCode;
    output.turn = result.state.turn;
    // 进入 Loop 的方式与会话历史条数：恢复实验的判据在存档里（session.messages），
    // 这里一并带出来，方便断言"续跑而不是重发任务输入"。
    output.resumeEntry = result.resumeEntry;
    output.sessionMessages = result.messages.length;
    output.recordStatus = result.record.status;
    output.checkpoints = result.checkpoints.length;
    output.checkpointSeq = result.record.counters.checkpoints;
    output.toolCalls = result.record.counters.toolCalls;
    output.planSteps = result.session.snapshot()?.steps.map((step) => ({
      id: step.id,
      status: step.status,
    })) ?? [];
    output.evidenceIds = result.session.evidence.list().map((item) => item.id);
    output.transitions = result.record.transitions.map((item) => ({
      seq: item.seq,
      from: item.from,
      event: item.event,
      to: item.to,
      detail: item.detail,
    }));
    output.resumedFromCheckpoint = result.record.resumedFromCheckpoint ?? false;
    output.decisions = result.record.decisions.map((item) => ({
      actionId: item.actionId,
      decision: item.decision,
      by: item.by,
      hash: item.patchHash,
      reason: item.reason,
    }));
    output.decisionsBy = result.record.decisionsBy;
    output.pendingApproval = result.record.pendingApproval?.actionId ?? null;
    output.pendingPatch = result.record.pendingApproval
      ? {
        actionId: result.record.pendingApproval.actionId,
        hash: result.record.pendingApproval.patchHash,
        args: result.record.pendingApproval.args,
      }
      : null;
    output.revision = result.runtime.getRevision();
    if (current.command.mode === "resume") {
      output.resumedPlanFinal = output.planSteps;
    }
  }
  return output;
}
