# 开发说明

## 当前实现

| 文件 | 职责 |
|---|---|
| `src/config.ts` | 显式读取 PA 配置、检查地址和预算、解析数据目录 |
| `src/runtime.ts` | 受限 Pi Session、会话历史、生命周期、独占锁、请求超时 |
| `src/store.ts` | Node 内置 SQLite、schema v2、业务事务与记忆版本/作用域 |
| `src/conversation.ts` | 业务消息与 Pi run marker 对应、启动核对、持久化失败处理 |
| `src/conversation-lock.ts` | 在线聊天与离线记忆管理共用的会话锁 |
| `src/memory-types.ts` | 记忆输入、版本、结果与业务错误契约 |
| `src/memory.ts` | 无模型配置的显式记忆四操作入口 |
| `src/cli.ts` | 参数、交互输入、离线历史查询、终端输出确认、正常退出 |
| `test/config.test.mjs` | 配置边界及实际 CLI 的配置/参数检查 |
| `test/cli-interaction.test.mjs` | 实际 CLI 多轮输入、管理指令、退出与重新启动 |
| `test/runtime.test.mjs` | 本地接口驱动真实 Pi SDK 的运行时集成检查 |
| `test/store.test.mjs` | 数据库事务、约束、作用域、版本与重开 |
| `test/conversation.test.mjs` | 真实 SDK 与 SQLite 的对应、崩溃恢复与取消 |
| `test/memory-store.test.mjs` | v1→v2 迁移、四操作、来源、版本、删除正文、作用域 |
| `test/memory-context.test.mjs` | 召回预算、上下文失效与重置故障恢复 |
| `test/memory-cli.test.mjs` | 实际离线 CLI 四操作 |

编译采用 NodeNext / ESM，源码内部 import 使用 `.js` 后缀。`npm run build` 输出 `dist`；改源码后重新构建，或运行 `npm run dev` 构建并进入 CLI。不要直接把 Pi 的默认 SDK 示例当成受限配置。

当前实现本地 CLI 的会话恢复与业务存储。会话名称是本地路由键，不是已经认证的 actor ID，也不代表平台身份。数据库的 actors 暂时只有本地 owner；rooms 使用 cli/local/会话名称作为键。将来接入 QQ / TG 时由 adapter/router 生成经过验证的路由键，用户不得通过消息自由指定他人的会话。

业务原文以 SQLite 为准，模型上下文以 Pi SessionManager 为准，不直接替换 agent.state.messages。两份记录无法做跨文件原子提交，因此用 run marker、关联 entry ID 和明确状态进行恢复，详见 [存储说明](storage.md)。marker 是 Pi 的 custom entry，不加入模型请求，避免修改提示词前缀。

## 接下来按顺序推进

1. **一个消息渠道**：QQ 或 Telegram 由用户选择，并核验实际权限。群聊默认只响应明确触发，身份绑定不靠昵称推断。
2. **受控 Web 工具**：确定供应商与预算后添加 web_search / web_fetch 白名单。
3. **后续成长**：预算内的轮后提取/整理、自我模型证据/反例/版本/回滚、主动互动冷却与幂等。不得用生成内容自我强化证据。

以上是后续阶段。SQLite 使用 Node 内置模块，未增加第三方依赖。schema v2 通过事务从 v1 增加显式记忆；渠道身份、自动整理和保留期限策略尚未实现。记忆契约与 Pi 上下文失效规则见 [memory.md](memory.md)。

## 后续隐私与连续性验收场景

| 场景 | 要求 |
|---|---|
| 同一私聊退出后重启 | 恢复对应会话上下文 |
| 两个本地会话 | 相互不看到原文；当前集成测试覆盖 |
| 两个平台同名用户 | 未经绑定保持不同 actor |
| 同一用户分别私聊和群聊 | 群聊不能注入其私聊原文或私密记忆 |
| 同一群不同成员 | 请求者不能越权管理另一人的私有记忆 |
| 两个不同群 | group_room 记忆不得跨群注入 |
| 自我模型引用私聊反馈 | 不把私聊内容自动变成公开 self_global 事实 |
| 用户纠正记忆 | 旧结论和派生证据失效，保留有权限的更新记录 |
| 用户删除记忆/原文 | 检查会话、摘要、索引、派生证据与备份策略 |
| 同一消息重复到达 | 去重且不重复请求或投递 |
| Telegram 不同聊天相同 message_id | 去重键包含 chat_id，不误删其他聊天事件 |
| 回复已生成但发送结果未知 | 记录 uncertain，不盲目重发并宣称 exactly-once |

模型配置、QQ / TG 的先后顺序、预算、保留期限和跨平台绑定方式尚未决定。不要把尚未确认的事项写成产品承诺。

## 设计资料

`docs/design/pi_evolving_companion_technical_design_v0.2.md` 是用户原文副本，用于保留设计基线。该文档末尾“首轮只调查”的交接指令属于历史阶段；用户当前已授权开始实现。本次以 CLI 纵向切片为范围，不一次性建设全架构。

2026-10-12 核验：[Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)、已安装的 1.1.0 TypeScript 声明与源码。仓库主分支文档可能变化，实际实现与检查以锁定依赖为准。
