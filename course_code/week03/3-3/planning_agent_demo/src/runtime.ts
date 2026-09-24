// 代码库工具的受控执行入口。
// 3.2 在 3.1 的 list/search/read/write 之外补上「修复闭环」需要的两个动作：
//   apply_patch：在目标仓库内做最小源码修改；
//   run_test：按约定范围运行测试，返回真实退出码。
// 这两个动作是计划层的证据来源：改动的 diff 与测试的 exitCode 只能由 Runtime 写入。
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { DemoExecutionContext } from "./run-context.js";
import type { EvidenceKind } from "./plan-store.js";

const run = promisify(execFile);

/** Runtime 产出的证据草稿；步骤 ID 与工具调用 ID 由计划层补全。 */
export interface ToolEvidence {
  kind: EvidenceKind;
  summary: string;
  payload: Record<string, unknown>;
}

export interface ManagedToolResult {
  ok: boolean;
  code: string;
  modelView: unknown;
  artifact?: string;
  evidence?: ToolEvidence;
}

export interface InvokeRequest {
  toolCallId: string;
  modelName: string;
  args: Record<string, unknown>;
  context: DemoExecutionContext;
  signal?: AbortSignal;
}

interface SearchMatch {
  path: string;
  line: number;
  preview: string;
}

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".yaml",
  ".yml",
]);

const TEST_SCOPES = ["target", "boundary", "regression"] as const;
type TestScope = (typeof TEST_SCOPES)[number];

export class DemoToolRuntime {
  private readonly callCounts = new Map<string, number>();
  private revisionSequence = 0;
  /** 已启动但未获得完整结果的测试：恢复时不得记为通过（R3/A3）。 */
  private readonly unfinishedTests = new Set<string>();

  /** 当前代码版本；任何一次成功的源码修改都会推进版本。 */
  getRevision(): string {
    return `r${this.revisionSequence}`;
  }

  /** 从存档恢复代码版本号，避免恢复后版本回退成 r0。 */
  restoreRevision(revision: string): void {
    const matched = /^r(\d+)$/.exec(revision);
    if (matched) {
      this.revisionSequence = Number(matched[1]);
    }
  }

  /** 测试是否处于「已启动、结果不明」状态。 */
  hasUnfinishedTest(toolCallId: string): boolean {
    return this.unfinishedTests.has(toolCallId);
  }

  clearUnfinishedTest(toolCallId: string): void {
    this.unfinishedTests.delete(toolCallId);
  }

  /**
   * 只校验并计算补丁计划，不写任何内容（R4：改源码前先保存具体补丁）。
   * 这里的目标文件内容哈希是批准后再校验的锚点。
   */
  async planPatch(request: {
    path: string;
    search: string;
    replace: string;
    context: DemoExecutionContext;
  }): Promise<{
    patchHash: string;
    occurrences: number;
    contentHash: string;
    /** 锚点已消失但替换结果已就位：说明同一次修改此前已经落盘。 */
    alreadyApplied: boolean;
  }> {
    const rawPath = requiredString(request.path, "path");
    const search = requiredString(request.search, "search");
    const replace = asString(request.replace, "");
    const filePath = resolveWithin(request.context.repoRoot, rawPath);
    const content = await readFile(filePath, "utf8");
    const occurrences = content.split(search).length - 1;
    const contentHash = createHash("sha256").update(content).digest("hex");
    const patchHash = createHash("sha256")
      .update([rawPath, search, replace, contentHash].join("\u0000"))
      .digest("hex");
    return {
      patchHash,
      occurrences,
      contentHash,
      alreadyApplied: occurrences === 0
        && replace.length > 0
        && content.includes(replace),
    };
  }

  /** 真正落盘一次已经审批通过的补丁。 */
  async commitPatch(request: {
    path: string;
    search: string;
    replace: string;
    context: DemoExecutionContext;
  }): Promise<ManagedToolResult> {
    return this.applyPatch({
      toolCallId: `commit-${this.revisionSequence}`,
      modelName: "apply_patch",
      args: {
        path: request.path,
        search: request.search,
        replace: request.replace,
      },
      context: request.context,
    });
  }

  async invoke(request: InvokeRequest): Promise<ManagedToolResult> {
    try {
      switch (request.modelName) {
        case "list_files":
          return await this.listFiles(request);
        case "search_code":
          return await this.searchCode(request);
        case "read_file":
          return await this.readSourceFile(request);
        case "write_file":
          return await this.writeArtifact(request);
        case "apply_patch":
          return await this.applyPatch(request);
        case "run_test":
          return await this.runTest(request);
        default:
          return failure("TOOL_NOT_FOUND", `未注册工具：${request.modelName}`);
      }
    } catch (error) {
      if (request.signal?.aborted) {
        return failure("ABORTED", "工具执行已取消");
      }
      return failure(
        "TOOL_EXECUTION_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  getHandlerCallCount(toolName: string): number {
    return this.callCounts.get(toolName) ?? 0;
  }

  private async listFiles(request: InvokeRequest): Promise<ManagedToolResult> {
    this.bump("list_files");
    const rawPath = asString(request.args.path, ".");
    const directory = resolveWithin(request.context.repoRoot, rawPath);
    const entries = await walk(directory, request.signal);
    const files = entries.map((entry) => relativeTo(request.context.repoRoot, entry));
    return success(
      "OK",
      { basePath: relativeTo(request.context.repoRoot, directory), files },
      undefined,
      {
        kind: "tool",
        summary: `列出 ${files.length} 个文件`,
        payload: { basePath: relativeTo(request.context.repoRoot, directory) },
      },
    );
  }

  private async searchCode(request: InvokeRequest): Promise<ManagedToolResult> {
    this.bump("search_code");
    const query = requiredString(request.args.query, "query");
    const rawPath = asString(request.args.path, ".");
    const directory = resolveWithin(request.context.repoRoot, rawPath);
    const files = await walk(directory, request.signal);
    const matches: SearchMatch[] = [];

    for (const filePath of files) {
      request.signal?.throwIfAborted();
      if (!TEXT_EXTENSIONS.has(path.extname(filePath))) {
        continue;
      }

      const content = await readFile(filePath, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, index) => {
        if (line.includes(query)) {
          matches.push({
            path: relativeTo(request.context.repoRoot, filePath),
            line: index + 1,
            preview: line.trim(),
          });
        }
      });
    }

    return success(
      "OK",
      {
        query,
        path: relativeTo(request.context.repoRoot, directory),
        matches: matches.slice(0, 20),
        total: matches.length,
      },
      undefined,
      {
        kind: "tool",
        summary: `搜索 ${query} 命中 ${matches.length} 处`,
        payload: { query, total: matches.length },
      },
    );
  }

  private async readSourceFile(request: InvokeRequest): Promise<ManagedToolResult> {
    this.bump("read_file");
    const rawPath = requiredString(request.args.path, "path");
    const filePath = resolveWithin(request.context.repoRoot, rawPath);
    const content = await readFile(filePath, "utf8");
    return success(
      "OK",
      { path: relativeTo(request.context.repoRoot, filePath), content },
      undefined,
      {
        kind: "inspection",
        summary: `读取 ${rawPath}`,
        payload: { path: rawPath, bytes: Buffer.byteLength(content, "utf8") },
      },
    );
  }

  private async writeArtifact(request: InvokeRequest): Promise<ManagedToolResult> {
    this.bump("write_file");
    const rawPath = requiredString(request.args.path, "path");
    const content = requiredString(request.args.content, "content");

    if (!rawPath.startsWith("artifacts/")) {
      return failure("ARTIFACT_PATH_DENIED", "本节演示只允许写入 artifacts/ 目录");
    }

    const filePath = resolveWithin(request.context.projectRoot, rawPath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
    const bytes = Buffer.byteLength(content, "utf8");

    return success("OK", { path: rawPath, bytes }, rawPath, {
      kind: "tool",
      summary: `写入交付物 ${rawPath}`,
      payload: { artifact: rawPath, bytes },
    });
  }

  /** 只允许修改目标仓库内的源码文件；替换锚点必须唯一。 */
  private async applyPatch(request: InvokeRequest): Promise<ManagedToolResult> {
    this.bump("apply_patch");
    const rawPath = requiredString(request.args.path, "path");
    const search = requiredString(request.args.search, "search");
    const replace = asString(request.args.replace, "");
    const filePath = resolveWithin(request.context.repoRoot, rawPath);

    const content = await readFile(filePath, "utf8");
    const occurrences = content.split(search).length - 1;
    if (occurrences === 0) {
      // 幂等重放：锚点已经消失、而目标片段已经就位，说明同一次修改此前
      // 已经落盘。此时再报失败会把"暂停→恢复"变成一次假的崩溃实验，
      // 因此明确返回 alreadyApplied，且绝不推进代码版本。
      if (replace.length > 0 && content.includes(replace)) {
        return success(
          "PATCH_ALREADY_APPLIED",
          { path: rawPath, revision: this.getRevision(), alreadyApplied: true },
          undefined,
          {
            kind: "diff",
            summary: `修改已在 ${rawPath} 生效，本次未重复写入（代码版本 ${this.getRevision()}）`,
            payload: {
              path: rawPath,
              revision: this.getRevision(),
              alreadyApplied: true,
            },
          },
        );
      }
      return failure("PATCH_ANCHOR_NOT_FOUND", `未找到待替换片段：${rawPath}`);
    }
    if (occurrences > 1) {
      return failure("PATCH_ANCHOR_NOT_UNIQUE", `待替换片段出现 ${occurrences} 次：${rawPath}`);
    }

    await writeFile(filePath, content.replace(search, replace), "utf8");
    this.revisionSequence += 1;

    return success(
      "OK",
      { path: rawPath, revision: this.getRevision() },
      undefined,
      {
        kind: "diff",
        summary: `修改 ${rawPath}，代码版本 ${this.getRevision()}`,
        payload: { path: rawPath, revision: this.getRevision() },
      },
    );
  }

  /** 只运行执行上下文里约定的测试文件；scope 是唯一入参。 */
  private async runTest(request: InvokeRequest): Promise<ManagedToolResult> {
    this.bump("run_test");
    const scope = requiredString(request.args.scope, "scope");
    if (!TEST_SCOPES.includes(scope as TestScope)) {
      return failure("TEST_SCOPE_INVALID", `未知测试范围：${scope}`);
    }

    const suites = {
      target: request.context.targetSuite,
      boundary: request.context.boundarySuite,
      regression: request.context.regressionSuite,
    };
    const suite = suites[scope as TestScope];
    const files = suite.files.map((file) =>
      resolveWithin(request.context.repoRoot, file)
    );
    const command = [process.execPath, "--import", "tsx", "--test", ...files];
    const relativeFiles = suite.files.map((file) => file);

    // 先登记「已启动」：若本轮进程在此之后异常退出，
    // 恢复时就能判定这次测试结果不明，而不是当作通过。
    this.unfinishedTests.add(request.toolCallId);

    let exitCode = 0;
    let output = "";
    let aborted = false;
    try {
      const result = await run(command[0], command.slice(1), {
        cwd: request.context.runtimeRoot,
        signal: request.signal,
        maxBuffer: 4 * 1024 * 1024,
      });
      output = `${result.stdout}${result.stderr}`;
    } catch (error) {
      const failureInfo = error as { code?: number | string; stdout?: string; stderr?: string };
      if (request.signal?.aborted) {
        aborted = true;
      }
      exitCode = typeof failureInfo.code === "number" ? failureInfo.code : 1;
      output = `${failureInfo.stdout ?? ""}${failureInfo.stderr ?? ""}`;
    }

    // 中断或未拿到真实退出码时，不能宣称测试通过。
    if (aborted) {
      return failure("TEST_RESULT_UNKNOWN", "测试已启动但未获得完整结果");
    }
    this.unfinishedTests.delete(request.toolCallId);

    const passed = exitCode === 0;
    return success(
      "OK",
      {
        scope,
        revision: this.getRevision(),
        files: relativeFiles,
        exitCode,
        passed,
        output: tail(output, 30),
      },
      undefined,
      {
        kind: "test",
        summary: `${scope} 测试 exit=${exitCode}`,
        payload: {
          scope,
          revision: this.getRevision(),
          exitCode,
          files: relativeFiles,
          passed,
        },
      },
    );
  }

  private bump(toolName: string): void {
    this.callCounts.set(toolName, (this.callCounts.get(toolName) ?? 0) + 1);
  }
}

function success(
  code: string,
  modelView: unknown,
  artifact?: string,
  evidence?: ToolEvidence,
): ManagedToolResult {
  return { ok: true, code, modelView, artifact, evidence };
}

function failure(code: string, message: string): ManagedToolResult {
  return { ok: false, code, modelView: { code, message } };
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`参数 ${field} 必须是非空字符串`);
  }
  return value;
}

function resolveWithin(root: string, target: string): string {
  const resolved = path.resolve(root, target);
  const normalizedRoot = path.resolve(root);
  if (
    resolved !== normalizedRoot
    && !resolved.startsWith(`${normalizedRoot}${path.sep}`)
  ) {
    throw new Error(`路径越界：${target}`);
  }
  return resolved;
}

function relativeTo(root: string, target: string): string {
  const relativePath = path.relative(root, target);
  return relativePath.length === 0 ? "." : relativePath;
}

function tail(text: string, lines: number): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

async function walk(root: string, signal?: AbortSignal): Promise<string[]> {
  const output: string[] = [];
  const queue = [root];

  while (queue.length > 0) {
    signal?.throwIfAborted();
    const current = queue.shift()!;
    const entries = await readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }

      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(nextPath);
        continue;
      }

      output.push(nextPath);
    }
  }

  return output.sort((left, right) => left.localeCompare(right));
}
