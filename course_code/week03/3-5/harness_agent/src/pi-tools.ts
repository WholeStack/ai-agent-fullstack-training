// 把 Runtime 与计划层的能力适配成 pi 的 AgentTool。
//
// 3.3 变化：apply_patch 不再直接落盘，而是先暂存待审批（R4）。
// 批准入口不在模型可见的工具里——人工入口是 `--resume <ID> --approve/--reject`，
// 机器路径是显式的 `--auto-approve`，两者共用 approval-flow 的同一段执行逻辑。
import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

import type { ApprovalGate } from "./approval.js";
import { applyApprovedPatch } from "./approval-flow.js";
import type { DemoExecutionContext } from "./run-context.js";
import {
  DemoToolRuntime,
  type ManagedToolResult,
} from "./runtime.js";
import { createPlanningTools } from "./plan-tools.js";
import type { PlanningSession } from "./plan-store.js";
import type { TaskRecorder } from "./task-record.js";

/** 必须绑定计划步骤、否则会被 LoopGuard 在执行前拦下的工具。 */
export const GOVERNED_TOOLS = new Set([
  "write_file",
  "apply_patch",
  "run_test",
]);

const PlanStepId = Type.Optional(Type.String({ minLength: 1 }));

const SearchCodeInput = Type.Object(
  {
    query: Type.String({ minLength: 1 }),
    path: Type.String({ minLength: 1 }),
    planStepId: PlanStepId,
  },
  { additionalProperties: false },
);

const ListFilesInput = Type.Object(
  {
    path: Type.Optional(Type.String({ minLength: 1 })),
    planStepId: PlanStepId,
  },
  { additionalProperties: false },
);

const ReadFileInput = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    planStepId: PlanStepId,
  },
  { additionalProperties: false },
);

const WriteFileInput = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    content: Type.String({ minLength: 1 }),
    planStepId: PlanStepId,
  },
  { additionalProperties: false },
);

const ApplyPatchInput = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    search: Type.String({ minLength: 1 }),
    replace: Type.String(),
    planStepId: PlanStepId,
  },
  { additionalProperties: false },
);

const RunTestInput = Type.Object(
  {
    scope: Type.Union([
      Type.Literal("target"),
      Type.Literal("boundary"),
      Type.Literal("regression"),
    ]),
    planStepId: PlanStepId,
  },
  { additionalProperties: false },
);

// Runtime 失败也保留结构化 details（尤其是取消测试证据）。runner 的
// afterToolCall 根据 details.ok 回填 pi 的 isError，不丢掉真实执行结果。
function toResult(modelView: unknown): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: JSON.stringify(modelView) }],
    details: {},
  };
}

function toPiResult(
  result: ManagedToolResult,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{
      type: "text",
      text: JSON.stringify(result.modelView),
    }],
    details: {
      ok: result.ok,
      code: result.code,
      modelView: result.modelView,
      artifact: result.artifact,
      evidence: result.evidence,
    },
  };
}

function createTool(
  name: string,
  label: string,
  description: string,
  parameters: AgentTool["parameters"],
  runtime: DemoToolRuntime,
  context: DemoExecutionContext,
): AgentTool {
  return {
    name,
    label,
    description,
    parameters,
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      // planStepId 只服务于计划校验，不属于业务参数，进入 Runtime 前剥离。
      const { planStepId: _planStepId, ...args } = params as Record<string, unknown>;
      const result = await runtime.invoke({
        toolCallId,
        modelName: name,
        args,
        context,
        signal,
      });
      return toPiResult(result);
    },
  };
}

export function createPlanningAgentTools(
  runtime: DemoToolRuntime,
  context: DemoExecutionContext,
  session: PlanningSession,
  hooks: {
    approval?: ApprovalGate;
    recorder?: TaskRecorder;
    /**
     * 自动批准（--auto-approve）：补丁仍走暂存、校验与 patchHash 比对，
     * 但由机器当场批准并落盘，只在 decisions 里留下 by:"auto" 的记录。
     * 审批语义（批准前不落盘、拒绝后不可执行）一字未改。
     */
    autoApprove?: boolean;
    /** 测试用：批准并落盘之后的回拨（用于制造崩溃点）。 */
    onAfterApproval?: () => Promise<void>;
  } = {},
): AgentTool[] {
  /**
   * apply_patch 在本节分为两步：
   *   1. 计划门禁已在 beforeToolCall 通过；
   *   2. 这里只暂存补丁与哈希，不写盘，返回 waiting_approval。
   * 真正的落盘发生在批准之后（人工 --approve 或 --auto-approve）。
   * 模型侧没有批准入口：否则"审批"就退化成模型给自己盖章。
   */
  const applyPatch: AgentTool = {
    name: "apply_patch",
    label: "Apply patch",
    description:
      "在目标仓库内做最小源码修改。本节需要人工审批：调用后会暂存补丁并进入等待审批，批准后才真正落盘。必须携带 planStepId。",
    parameters: ApplyPatchInput,
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      signal?.throwIfAborted();
      const args = params as {
        path: string;
        search: string;
        replace: string;
        planStepId?: string;
      };
      if (!hooks.approval) {
        // 没有审批层时退回直接执行，保持 3.2 行为可用。
        const { planStepId: _ignored, ...rest } = args;
        return toPiResult(await runtime.invoke({
          toolCallId,
          modelName: "apply_patch",
          args: rest,
          context,
          signal,
        }));
      }
      const plan = await runtime.planPatch({
        path: args.path,
        search: args.search,
        replace: args.replace,
        context,
      });
      signal?.throwIfAborted();
      // 幂等重放：锚点已消失、目标片段已就位，说明这次修改此前已经落盘。
      // 暂停后恢复的第二次 apply_patch 走的就是这条路；必须在这里放行，
      // 否则会以 PATCH_ANCHOR_NOT_FOUND 失败，把恢复变成一次假崩溃。
      if (plan.occurrences === 0 && plan.alreadyApplied) {
        return toPiResult(await runtime.commitPatch({
          path: args.path,
          search: args.search,
          replace: args.replace,
          context,
          signal,
        }));
      }
      if (plan.occurrences === 0) {
        throw new Error(JSON.stringify({
          code: "PATCH_ANCHOR_NOT_FOUND",
          content: { path: args.path },
        }));
      }
      if (plan.occurrences > 1) {
        throw new Error(JSON.stringify({
          code: "PATCH_ANCHOR_NOT_UNIQUE",
          content: { path: args.path, occurrences: plan.occurrences },
        }));
      }

      const pending = hooks.approval.stage({
        plan: {
          path: args.path,
          search: args.search,
          replace: args.replace,
          occurrences: plan.occurrences,
          patchHash: plan.patchHash,
        },
        stepId: args.planStepId ?? "__unbound__",
      });
      hooks.recorder?.stageApproval(pending);

      // --auto-approve：暂存之后立刻由机器批准。走的是与人工作出决定完全
      // 相同的执行段（approval-flow），差别只在 decisions 里的 by 标记。
      if (hooks.autoApprove) {
        if (!hooks.recorder) {
          throw new Error(JSON.stringify({ code: "APPROVAL_NOT_CONFIGURED" }));
        }
        const committed = await applyApprovedPatch(
          { approval: hooks.approval, runtime, session, recorder: hooks.recorder, context },
          {
            actionId: pending.actionId,
            by: "auto",
            reason: "--auto-approve：课堂实验自动放行",
            onAfterCommit: hooks.onAfterApproval,
            signal,
          },
        );
        // 证据已经由审批执行段登记过了。这里必须把 evidence 摘掉，
        // 否则 observeToolResult 会照着同一份工具结果再登记一条 diff 证据：
        // 一个补丁留两条证据，下游步骤引用的 ev-N 会整体错位。
        return toPiResult({ ...committed, evidence: undefined });
      }

      return toResult({
        ok: false,
        code: "WAITING_APPROVAL",
        actionId: pending.actionId,
        patchHash: pending.patchHash,
        path: pending.args.path,
        message: "补丁已暂存，等待人工审批后才会写入源码。批准前不会执行。",
      });
    },
  };

  return [
    createTool(
      "list_files",
      "List files",
      "列出代码仓库中的文件，用于了解项目结构。",
      ListFilesInput,
      runtime,
      context,
    ),
    createTool(
      "search_code",
      "Search code",
      "在代码仓库中搜索文本或符号。当你还不知道文件位置或调用方时使用。",
      SearchCodeInput,
      runtime,
      context,
    ),
    createTool(
      "read_file",
      "Read file",
      "只读取 repoRoot 内的源码或测试文件，沿调用链确认实现；artifacts/ 交付报告不在此读取范围，由完成检查核对实际文件。",
      ReadFileInput,
      runtime,
      context,
    ),
    createTool(
      "write_file",
      "Write artifact",
      "把结论写入 artifacts/ 目录。必须携带 planStepId。",
      WriteFileInput,
      runtime,
      context,
    ),
    applyPatch,
    createTool(
      "run_test",
      "Run test",
      "按约定范围运行测试并返回真实退出码。scope=target 目标用例，scope=boundary 到期边界，scope=regression 约定回归。必须携带 planStepId。",
      RunTestInput,
      runtime,
      context,
    ),
    ...createPlanningTools(session),
  ];
}
