# Planning Agent Demo

3.2 的配套工程：在 3.1 的 pi Agent Loop 上接入计划层，跑通「修复登录模块到期边界失败测试」的完整闭环。

## 3.3 新增（任务状态 / Checkpoint / 人工接管）

|文件|职责|
|---|---|
|`src/task-record.ts`|R1：任务状态机、步骤记录（工具调用 ID、输入输出、失败原因、重试、决策、证据）与状态迁移日志|
|`src/checkpoint.ts`|R2：存档格式、原子写入、校验和、工作区摘要、存档序号|
|`src/resume.ts`|R3：先检查再恢复，三态判定（completed / not_started / unknown）|
|`src/approval.ts`|R4：补丁暂存、patchHash 绑定参数与文件内容、跨进程重新审批|
|`src/approval-flow.ts`|R4 执行段：批准 → 重算 patchHash → 落盘 → 补证据；人工与 auto 两条入口共用|
|`src/fresh-run.ts`|R5：独立工作区重跑（`--replay`），原记录只读|
|`src/cli.ts`|课堂项目入口：参数、工作区、暂停/审批/恢复/重跑编排与报告输出|
|`src/journal.ts`|pi 低层 Session（JSONL）journal 适配层|
|`scripts/child-run.ts`|脚本化实验入口（与 `npm start` 共用 `src/cli.ts`，支持崩溃点）|
|`tests/checkpoint-resume.test.ts`|A1–A10 验收用例|

### 运行状态机

运行状态是一台显式状态机，每次迁移都记进 `TaskRecord.transitions`
（含自环，例如 `running -(task_interrupted)-> running`）：

```
running ⇄ waiting_tool           发出工具调用 / 工具返回
running → waiting_approval       补丁暂存，等人工决定（不是失败）
waiting_approval → running       批准，回到执行
waiting_approval → suspended     拒绝，停在原地等人工处置
running → suspended              重复动作 / 超轮数 / 模型错误（不是失败）
running → completed | failed | cancelled
```

人工暂停（`--pause-after`）**不改变状态**：任务仍是 `running`，只是停下来，
所以恢复时不会被当成"结果不明"。等待审批是**任务**在等，步骤本身仍是
`in_progress`，只在 `nextDecision` 上标 `await_approval`。

### pi 版本事实（0.84.4）

- 可用：`runAgentLoop` / `runAgentLoopContinue`、全部 Loop Hook、`Session` /
  `JsonlSessionRepo` / `NodeExecutionEnv`。
- **不可用**：`AgentHarness.resume()` 及 `AgentHarness` 其余方法在 0.84.4 是未实现的桩
  （抛 `HarnessNotImplemented`）。因此 R3 的「pi 续跑能力」落在
  低层 journal 判定 + `runAgentLoopContinue` 上。

### 存档位置与格式

存档写在临时工作区内：`<projectRoot>/.agent-runs/<runId>.json`，
信封包含 `schemaVersion`（当前 v2）、`runId`、`createdAt`、`seq`（第几份存档）、
`payload`、`checksum`。写入走「先写 .tmp 再 rename」，失败时保留最近一份有效存档。

### 运行模式

```bash
npm start                                   # 新运行（自动建临时工作区）
npm start -- --workspace <dir>              # 指定工作区
npm start -- --workspace <dir> --pause-after 6 --auto-approve
npm start -- --workspace <dir> --resume <runId>            # 先检查再恢复
npm start -- --workspace <dir> --resume <runId> --approve  # 批准待审批补丁
npm start -- --workspace <dir> --resume <runId> --reject   # 拒绝待审批补丁
npm start -- --workspace <dir> --replay <runId>            # 独立工作区重跑
```

|参数|作用|
|---|---|
|`--workspace <dir>`|工作区；恢复与重跑必须与上次指向同一个工作区|
|`--pause-after <N>`|第 N 个完整轮次结束、存档写盘之后优雅暂停：`stopCode=INTERRUPTED`、进程 exit 0、任务状态仍是 `running`|
|`--auto-approve`|机器放行待审批补丁：仍走暂存、`patchHash` 校验与落盘，只在 `decisions` 里记 `by:"auto"`|
|`--resume <runId>`|先校验存档、工作区与任务状态，再还原业务对象并续跑|
|`--approve` / `--reject`|人工入口：对存档里待审批的补丁作出决定，记 `by:"manual"`|
|`--replay <runId>`|原任务输入 + 初始代码，在独立工作区重跑|
|`--crash-point <name>`|在指定点位 `exit(137)`，模拟异常终止（实验用）|
|`--run-id <id>`|指定 runId|

没有决定就不启动模型：`--resume` 拿到有待审批动作的存档时，只打印待确认内容与
批准/拒绝命令，进程 exit 0。

新运行不静默覆盖：同一工作区里已经有同 `--run-id` 的**未终结**存档
（`running` / `waiting_approval` / `suspended`）时，新运行直接拒绝（exit 3）并提示改用
`--resume <runId>`——否则"暂停 → 继续"的实验做第二次就会把上一次的存档顶掉。
终态存档（`completed` / `failed` / `cancelled`）会被本次新运行覆盖，覆盖前打印一行提示；
想从头再跑一遍请用 `--replay` 或换一个 `--run-id`。

### 课堂实验入口（脚本化模型）

`scripts/child-run.ts` 用 faux 模型驱动同一条 Loop，参数与报告与 `npm start` 完全一致
（两者共用 `src/cli.ts`），便于反复观察中断与审批。`--scenario` 只决定"模型这一轮说什么"。

```bash
WS=$(mktemp -d)

# 场景一：跑到第 6 轮结束即优雅暂停（存档已写、进程 exit 0、任务仍是 running）
npx tsx scripts/child-run.ts --scenario ac_full --workspace "$WS" --run-id run-lab \
  --pause-after 6 --auto-approve
# 从存档检查并续跑：接着旧轮数、旧计划、旧证据继续
npx tsx scripts/child-run.ts --scenario ac_full --workspace "$WS" \
  --resume run-lab --auto-approve

# 场景二：不加 --auto-approve，补丁停在被拦住的地方（源码不变）
npx tsx scripts/child-run.ts --scenario ac4 --workspace "$WS2" --run-id run-fix "<任务描述>"
# 人工批准 / 拒绝（同一个 <runId>，两个进程）
npx tsx scripts/child-run.ts --scenario ac4 --workspace "$WS2" --resume run-fix --approve
npx tsx scripts/child-run.ts --scenario ac4 --workspace "$WS2" --resume run-fix --reject

# 场景三：在独立工作区重跑，原存档只读
npx tsx scripts/child-run.ts --scenario ac4 --workspace "$WS2" --replay run-fix
```

| 参数 | 作用 |
|---|---|
| `--pause-after <N>` | 第 N 轮存档写盘之后优雅暂停；`stopCode=INTERRUPTED`，进程 exit 0，任务状态仍是 `running` |
| `--auto-approve` | 机器放行待审批补丁：仍走暂存、`patchHash` 校验与落盘，只在 `decisions` 里记 `by:"auto"` |
| `--crash-point <name>` | 强制退出（exit 137）模拟异常终止，用于 A1–A3 |
| `--resume <runId>` | 先检查存档/工作区/任务状态，再还原业务对象并续跑 |
| `--approve` / `--reject` | 人工入口：批准或拒绝存档里的待审批补丁（`by:"manual"`）|
| `--replay <runId>` | 原任务输入 + 初始代码，在独立工作区重跑 |

不加 `--auto-approve` 时，补丁停在 `waiting_approval` 且源码不变——这是 R4 的默认语义。
模型侧没有批准工具：批准只能来自人工入口或显式的 `--auto-approve`，
否则"审批"会退化成模型给自己盖章。

### 可反复执行的实验（真实 Gateway）

`npm run lab:cycle` 用 `npm start` 的同一个入口把"中断 → 恢复"整个闭环跑一遍，
并且**每跑一次都换一个新的临时工作区**，所以同一条命令可以反复执行、互不影响：

```bash
npm run lab:cycle                        # 第 6 轮结束优雅暂停 → 从存档恢复续跑，并逐条核对
npm run lab:cycle -- --pause-after 4     # 换暂停点
npm run lab:cycle -- --run-id run-lab2   # 换 runId
npm run lab:cycle -- "<任务描述>"         # 换任务输入
```

第 1 段暂停点是优雅暂停（exit 0、任务状态仍是 `running`）；第 2 段 `--resume` 把存档里的
**会话历史**回灌给 pi 的续跑入口（报告里的"续跑方式"一行会写明），接着旧轮数继续，
而不是把任务输入再发一遍。脚本核对退出码、存档里的会话历史（累积且不重发任务输入）、
轮数与存档序号，全部成立才 exit 0，否则逐条打印 ✗ 并 exit 1。
工作区路径会打印出来，存档在 `<workspace>/.agent-runs/<runId>.json`。
`--workspace <dir>` 复用已有工作区；里面若已有同 runId 的未终结存档，第 1 段会被拒绝——
那正是"该续跑"的场景，请直接用 `npm start -- --workspace <dir> --resume <runId>`。

## 跑起来

```bash
npm install
npm test          # 计划规则 + Loop 集成 + A1–A10 验收，共 32 个用例
npm run build     # tsc 类型检查
npm start         # 接真实 Gateway，模型驱动同一条 Loop，中文输出
```

## 结构

沿用 3.1 的文件分工，本节新增计划相关模块：

|文件|职责|
|---|---|
|`src/model.ts`|模型注册，接入 Gateway（与 3.1 相同）|
|`src/run-context.ts`|一次 Run 的路径边界，以及目标/边界/回归三组测试范围|
|`src/runtime.ts`|受控执行入口：读写文件、`apply_patch`、`run_test`，并产出证据|
|`src/plan-store.ts`|计划状态：依赖检查、证据校验、原子修订、修订预算|
|`src/plan-tools.ts`|`create_plan` / `get_plan` / `update_plan_step` / `revise_plan`|
|`src/completion-contract.ts`|完成契约：代码理解任务与修复任务各一份|
|`src/planning-prompt.ts`|运行提示词与每轮替换的计划快照|
|`src/pi-tools.ts`|把 Runtime 与计划层适配成 pi 的 AgentTool|
|`src/loop-guard.ts`|轮数、重复动作、计划门禁、完成契约与 Follow-up|
|`src/agent-runner.ts`|装配 pi Loop 与计划层，落档与人工决定|
|`src/cli.ts`|课堂项目入口：参数、工作区、三个入口（运行/恢复/重跑）与报告|
|`src/main.ts`|真实 Gateway 入口，把 Gateway 接进 `src/cli.ts`|
|`tests/plan-store.test.ts`|计划层不变量|
|`tests/agent-runner.test.ts`|Loop 集成：拦截、证据、修订、完成契约|
|`tests/checkpoint-resume.test.ts`|A1–A10：恢复、结果不明、审批、授权失效、三个课堂场景|
|`fixtures/demo-app/`|目标仓库：登录流程 + 待修复的会话有效期判断|

## 案例

`fixtures/demo-app/src/auth/session-policy.ts` 的 `isSessionExpired` 只比较 UTC 日期，
会话会晚最多 24 小时失效。CI 里只在跨 UTC 日界线时偶发失败，课堂用固定时钟在
`tests/session-boundary.test.ts` 里稳定复现。

修复前 `tests/session-policy.test.ts` 与 `tests/session-boundary.test.ts` 失败，
`tests/login-flow.test.ts` 通过。修复只改 `session-policy.ts`，公共 API 不变。

## 课堂观察点

1. `modifyPasswordLogic` 在 `reproduce` 完成前不能启动。
2. 没有证据、证据不属于该步骤、证据满足不了验收条件，三种情况都不能完成。
3. `revise_plan` 保留旧步骤并标记 `skipped`，下游依赖原子改接到新步骤。
4. 修订必须带理由和证据，并受 `maxRevisions` 限制；校验失败时原计划一字不变。
5. 当前代码版本之外的测试通过结果不能用于交付。
6. 计划已创建时，写入、改代码、跑测试必须携带 `planStepId`，否则在执行前被拦下。
7. 模型提前给出 Final Answer 不会结束任务，完成契约会拒绝并注入 Follow-up。

## 3.3 课堂观察点

1. 暂停（`suspended`）与等待审批（`waiting_approval`）不算任务失败。
2. 工具返回 `ok:true` 不等于测试通过：测试退出码才是验证完成的依据。
3. 恢复固定顺序：校验存档 → 校验工作区 → 校验任务状态 → 还原 → 续跑。
4. 结果不明的写操作绝不自动重放，只输出核查信息。
5. 批准前与拒绝后都不执行补丁；批准只对对应 actionId 生效。
6. 补丁参数或文件内容变化后，旧授权因 `patchHash` 失效（`APPROVAL_STALE`）。
7. 进程重启不默认获得批准（`approved` 由内存决定）；重启后要改代码，必须由人工
   重新批准，或由显式的 `--auto-approve` 放行。
8. 重跑使用独立工作区，原存档字节级不变。
9. `--pause-after N` 是优雅暂停：存档先落盘再停，进程 exit 0，任务状态仍是
   `running`（不是 `failed`，也没终结）；恢复时能直接判定可续跑，不会落进「结果不明」。
10. `--auto-approve` 不绕过审批：补丁仍要暂存、仍要算 `patchHash`、仍要落盘校验，
    区别只在 `decisions[].by` 记成 `auto`，人工批准记成 `manual`。
11. 恢复后新增证据的 `ev-N` 序号接在旧序号之后，既不重号也不回退——
    这是跨进程续跑能通过 `PLAN_EVIDENCE_STALE` 与完成契约的前提。
12. 状态迁移是证据：`#seq from -(event)-> to（detail）` 逐条写出"为什么停在这里、
    恢复后接着谁"，`waiting_tool` / `waiting_approval` / `task_interrupted` 都能被核对。
13. 模型侧没有批准入口：批准只能来自人工 `--approve` 或显式的 `--auto-approve`。
14. 没有决定就不启动模型：遇到待审批动作的 `--resume` 只打印待确认内容与两条命令。
15. 报告必须给出测试退出码与写入产物：最终状态只是入口，文件改动和验证记录才是依据。
16. 一次补丁只留一条 diff 证据（审批执行段登记后，工具结果不再重复登记）。
