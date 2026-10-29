# PA 开发入口（轻量 repo harness）

本页服务于开发 PA 的人和编码 Agent；应用中负责上下文、记忆、工具与投递的 runtime harness 仍按现有模块运行。这里串起已有约定、开发命令、故障回归和诊断，不增加产品框架或任务调度系统。

## 首次接手

1. 阅读根目录 [AGENTS.md](../AGENTS.md)，执行 `git status --short`，保留已有改动。
2. 使用 Node.js 24.15.0 或更高版本，在仓库执行 `npm ci`，通过 lockfile 安装依赖。
3. 执行 `node scripts/repo-check.mjs --list` 查看检查范围。离线开发检查不需要 `.env`、QQ 凭证、真实模型或生产数据库。
4. 根据任务选择下面一行，读相关模块和资料，先确定输入、预期结果与最窄检查。命令在仓库根目录输入；脚本内部始终以仓库为工作目录。

需要实际聊天时，另按 [README](../README.md#环境与启动) 配置 `.env` 和独立 `PA_DATA_DIR`；模型调用、QQ 服务和后台记忆可能产生真实外部行为。普通离线回归只使用临时目录和本地模拟。

## 按任务找入口

| 任务 | 优先看代码 | 对应资料 | 检查 scope |
|---|---|---|---|
| 已确认并发与本地效率回归 | `web-search.ts`、`research-service.ts`、`auto-memory-store.ts`、`context-tokens.ts` | [效率修复](efficiency.md) | `efficiency`；只覆盖本轮确认问题 |
| 拉取仓库、对齐线上版本、只读状态巡检 | `scripts/ops/sync-and-check.mjs`、`scripts/ops/server-status.mjs` | [同步与巡检](operations.md) | 脚本修改用 `ops`；日常巡检不启动产品或跑全套回归 |
| 对话、工具循环、准备与回答 | `runtime.ts`、`turn-plan.ts`、`answer-grounding.ts`、`channel-harness.ts`、`cli.ts` | [模块与边界](development.md#模块与边界)、[循环流程](design/companion-tool-loop.md) | `chat` |
| 人物/AI 画像、Topic、资料失败恢复 | `auto-memory.ts`、`auto-memory-store.ts`、`material-profile-wire.ts`、`profile-*.ts`、`self-profile-store.ts` | [记忆](memory.md) | `memory` |
| 历史投影、人物标签、token 校准、容量压缩 | `conversation.ts`、`context-people.ts`、`context-tokens.ts`、`runtime.ts`、`image-context.ts` | [记忆](memory.md)、[存储](storage.md) | `context` |
| 缓存前缀、命中骤降、提示/工具投影或 Pi 升级 | `runtime.ts`、`scripts/ops/server-status.mjs` | [缓存契约与故障检查](context-cache.md) | `cache`；按实际 HTTP 请求核对前缀，巡检读取真实用量及指纹 |
| 队列、分段、重复或未知投递 | `channel-harness.ts`、`store.ts`、`markdown-chunks.ts`、`qq-channel.ts` | [QQ 长回答](qq-long-replies.md)、[恢复边界](robustness-review.md) | `delivery` |
| 研究清单、材料、报告和清理 | `research-*.ts`、`scripts/deployment/research-retention.mjs` | [研究](research.md)、[正文保留](research-retention.md) | `research` |
| 搜索、抓网页、代理、图片 | `web-search.ts`、`web-fetch*.ts`、`image-assets.ts`、`image-context.ts` | [开发说明](development.md)、[网页代理](deployment.md#pa-网页读取代理) | `web` |
| schema、迁移、原文与任务状态 | `store.ts`、`auto-memory-store.ts`、`research-store.ts` | [存储](storage.md) | `storage`，再加受影响业务范围 |
| 启动核验、Pi损坏隔离与渠道调度 | `session-integrity.ts`、`session-integrity-store.ts`、`channel-harness.ts` | [启动和调度](startup-and-scheduling.md) | `storage chat` |
| 一次性提醒、取消、到期通知与重启恢复 | `reminder-tools.ts`、`reminder-service.ts`、`work-ledger-store.ts` | [提醒](reminders.md)、[工作台账](work-ledger.md) | `chat delivery storage`；精确命令见提醒文档 |
| GitHub Trending 群日报、定时生成与投递 | `trending-*.ts`、`channel-harness.ts` | [Trending日报](trending.md) | `trending`；改网页下载时加`web`，改输出队列时加`delivery` |
| 诊断与离线解析重放 | `diagnostics.ts`、`logs.ts`、`logs-cli.ts` | [统一日志](logging.md) | 对应业务范围；整理诊断用 `memory` |
| 发布、备份、轮换、回退 | `scripts/deployment/` | [部署](deployment.md) | 先验证相关代码；生产操作按本次授权执行 |

代码路径相对于 `src/`，明确以 `scripts/` 开头的除外。scope 是已有回归文件的集合，可重叠；文件分组与实际执行清单由 [repo-check.mjs](../scripts/repo-check.mjs) 统一维护。它们用于选择检查，不承诺该功能已全面覆盖。

## 运行检查

```powershell
# 只看范围；不编译、不跑测试。
node scripts/repo-check.mjs --list
node scripts/repo-check.mjs memory delivery --list

# 编译（含类型检查）一次，再运行所选现有回归；跨范围自动去重。
node scripts/repo-check.mjs memory
node scripts/repo-check.mjs chat delivery

# 综合改动或需要全量确认时运行全部现有回归。
node scripts/repo-check.mjs all
```

运行前需要本地依赖。编译失败会停止，测试失败会返回非零退出码；测试文件并发固定为 2。脚本不加载项目 `.env`，不启动产品或后台任务；只编译到已忽略的 `dist/` 并运行仓库现有离线测试。它不是 OS 网络沙箱，新增用例仍需遵守本地模拟和临时数据约定。

原 `npm run check`、`npm run build`、`npm test` 保留。仅调整文案/链接时做相关内容与链接核对即可，不为凑流程运行整套回归；需要精确到单文件时先 `npm run build`，再 `node --test --test-concurrency=2 test/文件名.test.mjs`。

## 用故障得到可信反馈

先确认失败属于哪一层：模型请求、解析/提案、身份权限、业务提交、QQ 投递。按 taskId/jobId/callId 查 [日志](logging.md#查询与离线重放)，使用脱敏输入和临时库复现；`logs replay --offline` 只检查现有证据的解析/校验，不执行工具、不提交业务，也不能证明语义正确。

现有例子可直接复用：

- **一个画像失败不拖垮整批**：`test/material-components-e2e.test.mjs` 验证 Alice/Topic 成功、Bob 失败，重启后只补 Bob；同时检查同条消息的其他 pending 不被顺带归档。
- **真实 @ 和文本伪 @**：`test/channel-async.test.mjs` 检查渠道入库、重启、旧元数据修复和权限差异。
- **补齐不打乱时间**：`test/memory-recovery-e2e.test.mjs` 检查恢复来源、较新纠正和基线合并后的来源继承。

保留依据见 [test/regressions.json](../test/regressions.json)。修复优先扩展匹配的故障回归，不公开私有聊天或故障日志，不为了引入 harness 批量新增测试。真实模型语义和 QQ 展示仍需单独验收。

## 修改与交接

开始时明确本次目标、影响模块和可观察的预期结果；小任务直接执行，不要求额外计划文件。完成后查看 diff，运行适合范围的检查，更新同一处当前规则；非小型代码变更做独立只读审查。

跨会话接续时，现有 Issue/PR 可承载进度；没有时给出简短交接即可：目标、分支/提交及未提交文件、已跑命令与结果、剩余问题和下一步。说明真实模型/生产验证是否执行以及未获授权的操作，不把历史授权当成未来部署许可。

当前开发事实见本页、AGENTS 与对应主题文档；旧设计解释取舍，历史快照解释迁移。数字限制尽量指向配置或定义位置，例如人物容量在 `src/profile-limits.ts`，避免多处维护相互冲突的值。

本项目用户约定“拉仓库/同步最新代码”同时包含服务器只读巡检；按[同步与巡检](operations.md)执行。同步分支不代表线上已经部署，服务active也不代表任务和记忆恢复正常。报告分别说明本地/远端/部署版本、检查窗口、具体异常和未检查项。检查结果放忽略的`.local/ops/`，不把聊天、画像、凭据或某次生产快照写进本页。新增模块或运维入口时维护上表及对应主题文档，避免再维护第二套检查清单。
