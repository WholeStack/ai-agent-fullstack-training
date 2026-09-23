// 真实 Gateway 入口：让模型驱动同一条计划化 Loop。
//
// 参数与报告都由 src/cli.ts 提供，与脚本化实验入口共用同一套语义：
//   npm start                                          —— 新运行（自动建临时工作区）
//   npm start -- --workspace <dir> --pause-after 6 --auto-approve
//   npm start -- --workspace <dir> --resume <id>       —— 先检查再恢复
//   npm start -- --workspace <dir> --resume <id> --approve|--reject
//   npm start -- --workspace <dir> --replay <id>       —— 独立工作区重跑
import { runCli } from "./cli.js";
import { gatewayModel, models } from "./model.js";

const controller = new AbortController();
process.on("SIGINT", () => {
  // SIGINT 是取消终态；可恢复的优雅暂停请使用 --pause-after。
  controller.abort();
});

const outcome = await runCli({
  argv: process.argv.slice(2),
  createModel: () => ({
    model: gatewayModel,
    streamFn: models.streamSimple.bind(models),
  }),
  signal: controller.signal,
  onText: (delta) => process.stdout.write(delta),
});

process.exit(outcome.exitCode);
