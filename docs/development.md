# 开发说明

## 当前实现

| 文件 | 职责 |
|---|---|
| `src/config.ts` | 显式读取 PA 配置、检查地址和预算、解析数据目录 |
| `src/runtime.ts` | 受限 Pi Session、会话历史、生命周期、独占锁、请求超时 |
| `src/store.ts` | Node 内置 SQLite、schema v5、渠道/人物身份、事件去重、作用域、审计与上下文水位 |
| `src/memory-service.ts` / `src/harness-policy.ts` | 自然画像更新、owner 四操作和本地身份权限 |
| `src/channel-harness.ts` | 通用房间白名单、参与判断、背景上下文、调用预算和投递确认 |
| `src/qq-channel.ts` / `src/qq-cli.ts` | QQ 协议适配与白名单群聊/私聊启动入口 |
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
| `test/memory-store.test.mjs` | v1–v4→v5 迁移与回滚、人物绑定、三类记忆、有效期、来源、版本与删除正文 |
| `test/channel-harness.test.mjs` / `test/qq-channel.test.mjs` | 本地真实 SDK 群聊集成、费用次数/去重、协议与连接维护 |
| `test/memory-context.test.mjs` | 召回预算、上下文失效与重置故障恢复 |
| `test/memory-cli.test.mjs` | 实际离线 CLI 四操作 |

编译采用 NodeNext / ESM，源码内部 import 使用 `.js` 后缀。`npm run build` 输出 `dist`；改源码后重新构建，或运行 `npm run dev` 构建并进入 CLI。不要直接把 Pi 的默认 SDK 示例当成受限配置。

CLI 会话名称是本地路由键，不代表平台身份。QQ 的 rooms 按 channel/account/room_type/room_id 唯一，actors 按房间和渠道 senderId 隔离；仅 primaryPerson 明确绑定的本人身份共享个人记忆/画像，不通过昵称推断身份。harness 生成固定路由摘要绑定 Pi 会话，聊天文本不能指定他人的会话。全量普通群消息先入业务库，群内明确 @ 才触发模型，白名单私聊直接回复。三块记忆与最近同房间背景按真实当前发送者组织，业务原文保持独立。

业务原文以 SQLite 为准，模型上下文以 Pi SessionManager 为准，不直接替换 agent.state.messages。两份记录无法做跨文件原子提交，因此用 run marker、关联 entry ID 和明确状态进行恢复，详见 [存储说明](storage.md)。marker 是 Pi 的 custom entry，不加入模型请求，避免修改提示词前缀。

用户已明确通用能力归 harness：会话、身份与隐私作用域、记忆四操作、工具与模型执行、参与判断、调度、预算和业务存储共用一套实现。QQ 等渠道只规范化输入、提供 @ / 引用 / 附件与渠道权限信息、执行收发和协议连接维护。菜单、按钮只是可选入口，不建设 QQ 专用记忆或参与逻辑；后续渠道复用同一 harness，数据仍按身份和房间隔离。

## 接下来按顺序推进

1. **QQ 官方 Bot 渠道**：已验证 @ 收发、全量消息接收和主动发送；已接入 harness，并在测试群完成 DeepSeek 官方 deepseek-flash 的两轮真实 AI 对话，验证普通消息背景和连续上下文，用户确认收到两轮回复。全量模式按 QQ 服务端 `mentions[].is_you` 识别自己，不将 READY ID 与群 OpenID 混用。按用户要求本地已设 `PA_QQ_MAX_MODEL_CALLS=0` 持续运行，仍仅 @ 时调用，关闭深度思考；单轮模型失败后可等待新消息，Pi/SQLite 持久化故障则停止。此前实群验收记录在 `.local/pa/qq-service/live-validation.json`。Telegram 后续推进。能力优先级见 [QQ 能力映射](qq-capability-map.md)，进群和费用边界见 [官方 Bot 测试准备](qq-official-test-setup.md)。
2. **受控 Web 工具**：确定供应商与预算后添加 web_search / web_fetch 白名单。
3. **后续成长**：预算内的轮后提取/整理、自我模型证据/反例/版本/回滚、主动互动冷却与幂等。不得用生成内容自我强化证据。

SQLite 使用 Node 内置模块，未增加第三方依赖。schema v4 单事务迁移 v1/v2/v3，保留旧记录，并增加记忆 subject/writer/field/scope、控制消息类型及背景水位；群记忆已接入 harness，owner 的完整管理与普通人的本人更新分别鉴权。旧记忆为 legacy，不推断归属或自动公开。自动整理、跨平台身份自动绑定、全局 AI 画像和保留期限策略尚未实现。记忆与上下文失效规则见 [memory.md](memory.md)。

## 后续隐私与连续性验收场景

| 场景 | 要求 |
|---|---|
| 同一私聊退出后重启 | 恢复对应会话上下文 |
| 两个本地会话 | 相互不看到原文；当前集成测试覆盖 |
| 两个平台同名用户 | 未经绑定保持不同 actor |
| 同一用户分别私聊和群聊 | 原始聊天仍按房间隔离；仅明确 primaryPerson 本人绑定共享个人长期记忆/画像 |
| 同一群不同成员 | 请求者不能越权管理另一人的私有记忆 |
| 两个不同群 | group_room 记忆不得跨群注入 |
| 自我模型引用私聊反馈 | 不把私聊内容自动变成公开 self_global 事实 |
| 用户纠正记忆 | 旧结论和派生证据失效，保留有权限的更新记录 |
| 用户删除记忆/原文 | 检查会话、摘要、索引、派生证据与备份策略 |
| 同一消息重复到达 | 去重且不重复请求或投递 |
| Telegram 不同聊天相同 message_id | 去重键包含 chat_id，不误删其他聊天事件 |
| 回复已生成但发送结果未知 | 记录 uncertain，不盲目重发并宣称 exactly-once |

QQ 优先于 Telegram，DeepSeek 官方 API 已在测试群常驻接入；保留期限和跨平台绑定方式尚未决定。

## 设计资料

`docs/design/pi_evolving_companion_technical_design_v0.2.md` 是用户原文副本，用于保留设计基线。该文档末尾“首轮只调查”的交接指令属于历史阶段；用户当前已授权开始实现。本次以 CLI 纵向切片为范围，不一次性建设全架构。

2026-10-12 核验：[Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)、已安装的 1.1.0 TypeScript 声明与源码。仓库主分支文档可能变化，实际实现与检查以锁定依赖为准。
