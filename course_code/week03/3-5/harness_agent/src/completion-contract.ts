// ============================================================================
// 完成契约：把「什么算完成」从 LoopGuard 的硬编码里提取出来。
//
// 3.1 的 LoopGuard 直接判断 artifacts/login-flow.md，只适用于代码理解任务。
// 3.2 同一套 Loop 要跑两类任务，因此把验收对象做成可注入的契约：
//   - 代码理解任务：读取足量源码 + 生成说明文档；
//   - 测试修复任务：当前代码版本上有改动、有通过的测试、有交付说明。
// ============================================================================
import type { Evidence, PlanSnapshot } from "./plan-store.js";

/** Runtime 在完成检查时读取的现场；路径与内容摘要不能由模型声明。 */
export interface CompletionState {
  verificationDigest: string;
  source: { path: string; contentHash: string | null; nonEmpty: boolean };
  artifact: { path: string; contentHash: string | null; nonEmpty: boolean };
}

export interface CompletionInput {
  plan?: PlanSnapshot;
  evidence: Evidence[];
  /** 兼容存档的 rN；内容是否相同还必须核对现场摘要。 */
  revision: string;
  current?: CompletionState;
}

export interface CompletionContract {
  id: string;
  verify(input: CompletionInput): string[];
}

function unfinishedSteps(plan?: PlanSnapshot): string[] {
  if (!plan) return ["尚未创建计划"];
  return plan.steps
    .filter((step) => step.status !== "completed" && step.status !== "skipped")
    .map((step) => `步骤未完成：${step.id}（${step.status}）`);
}

function artifactMissing(evidence: Evidence[], artifact: string, current?: CompletionState): string | undefined {
  const written = evidence.findLast(
    (item) => item.kind === "tool" && item.payload.artifact === artifact,
  );
  if (!written) return `缺少交付说明的写入证据：${artifact}`;
  if (!current || current.artifact.path !== artifact) return `尚未核对交付说明现场：${artifact}`;
  if (current.artifact.contentHash === null) return `交付说明已删除或不存在：${artifact}`;
  if (!current.artifact.nonEmpty) return `交付说明为空：${artifact}`;
  if (written.payload.contentHash !== current.artifact.contentHash) {
    return `交付说明与最后写入的内容不一致：${artifact}；请核对并重新交付`;
  }
  return undefined;
}

/** 3.1 已有的代码理解契约：读够源码，并交付说明文档。 */
export function createCodeUnderstandingContract(options: {
  targetArtifact: string;
  minReadFiles?: number;
}): CompletionContract {
  const minReadFiles = options.minReadFiles ?? 3;
  return {
    id: "code-understanding",
    verify({ plan, evidence, current }) {
      const missing = unfinishedSteps(plan);
      const readFiles = new Set(
        evidence
          .filter((item) => item.kind === "inspection")
          .map((item) => item.payload.path)
          .filter((value): value is string => typeof value === "string"),
      );
      if (readFiles.size < minReadFiles) {
        missing.push(`至少读取 ${minReadFiles} 个相关源码文件，当前 ${readFiles.size} 个`);
      }
      const artifactIssue = artifactMissing(evidence, options.targetArtifact, current);
      if (artifactIssue) {
        missing.push(artifactIssue);
      }
      return missing;
    },
  };
}

/** 3.2 的修复契约：当前版本上有改动、约定范围的测试都通过、并有交付说明。 */
export function createLoginFixContract(options: {
  targetSource: string;
  targetArtifact: string;
  /** 必须全部通过的测试范围。 */
  requiredScopes?: string[];
}): CompletionContract {
  const requiredScopes = options.requiredScopes ?? ["target", "boundary", "regression"];
  return {
    id: "login-fix",
    verify({ plan, evidence, revision, current }) {
      const missing = unfinishedSteps(plan);
      const patched = evidence.findLast(
        (item) => item.kind === "diff"
          && item.payload.path === options.targetSource
          && item.payload.alreadyApplied !== true,
      );
      if (!current) missing.push("尚未核对当前源码、测试与配置的内容指纹");
      if (
        !patched
        || patched.artifactVersion !== revision
        || typeof patched.payload.beforeHash !== "string"
        || patched.payload.beforeHash === patched.payload.contentHash
        || !current?.source.contentHash
        || current.source.path !== options.targetSource
        || patched.payload.contentHash !== current.source.contentHash
      ) {
        missing.push(`当前 ${options.targetSource} 与有效修改证据不一致或缺失；请核对实际改动`);
      }

      for (const scope of requiredScopes) {
        // 先取最后一次尝试，再判断其有效性。取消或未知不能跳过后沿用旧通过。
        const latest = evidence.findLast(
          (item) => item.kind === "test" && item.payload.scope === scope,
        );
        let reason: string | undefined;
        if (!latest) reason = "尚未执行";
        else if (latest.payload.resultCode !== "OK") {
          reason = `最近一次结果 ${String(latest.payload.resultCode ?? "未知")}，不能作为通过证据`;
        } else if (latest.payload.exitCode !== 0 || latest.payload.passed !== true) {
          reason = `最近一次未通过（exit=${String(latest.payload.exitCode)}）`;
        } else if (latest.payload.stable !== true
          || latest.payload.beforeDigest !== latest.payload.afterDigest) {
          reason = "测试期间输入变化或缺少前后指纹";
        } else if (!current || latest.artifactVersion !== revision
          || latest.payload.verificationDigest !== current.verificationDigest
          || latest.payload.beforeDigest !== current.verificationDigest) {
          reason = "源码、测试或配置与受测内容不一致";
        }
        if (reason) missing.push(`当前版本缺少通过的测试范围：${scope}；${reason}，请重新运行 run_test`);
      }

      const artifactIssue = artifactMissing(evidence, options.targetArtifact, current);
      if (artifactIssue) missing.push(artifactIssue);
      return missing;
    },
  };
}
