# 开发说明

当前实现遵循 [记忆 v1 确认方案](design/companion_memory_v1.md)，运行配置与命令见 [memory.md](memory.md)。后台模型默认关闭，离线验证完成后仍须分别确认真实模型预算及 QQ 事件。

## 模块与边界

| 文件 | 职责 |
|---|---|
| src/config.ts | 聊天、后台调用预算及可选 Embedding 配置，不读取其他应用凭据 |
| src/runtime.ts | 受限 Pi 会话、独立 ModelRuntime 工厂、最终输入容量估算、公开 API 重建投影 |
| src/store.ts | schema v7、原文/run/投递、显式记忆、迁移备份、去重和上下文水位 |
| src/auto-memory-store.ts | 通用 person 绑定、固定批次、任务租约、子批次检查点、Topic/画像/向量 |
| src/self-profile-store.ts | 全局AI画像修订、带来源待整理建议、原子归档和并发版本检查 |
| src/auto-memory.ts | 与聊天独立的后台调度、严格输出校验、有限重试、容量等待及 Topic 检索 |
| src/memory-provider.ts | 独立 Pi 提取请求与显式 Embedding HTTP 接口 |
| src/conversation.ts | 原文与 Pi 关联恢复、按当前发送者/@对象构造上下文、画像预算和私聊续聊 |
| src/channel-harness.ts | 先入库、按房间排队、参与判断、聊天预算、投递和启动后台恢复 |
| src/channel-types.ts / src/qq-channel.ts | 标准化发送者与真实 mention 目标、QQ 收发/鉴权/重连 |
| src/harness-policy.ts / src/memory-service.ts | 明确人物绑定、独立 owner 权限、本人显式更新及记忆管理 |
| src/cli.ts / src/memory.ts | 本地聊天和离线 remember/query/correct；拒绝删除 |
| src/memory-jobs-cli.ts | 无模型调用的任务状态查询和失败任务重新排队 |

沿用 NodeNext / ESM，内部 import 使用 .js 后缀。数据库采用 Node 内置 node:sqlite，向量在同一库持久化并在房间范围内精确检索；没有 ORM、Python 或新生产依赖。

渠道只提供身份、@、消息和传输；记忆、调度、权限与模型调用属于 harness。身份共享不授予管理权限。聊天和整理不共用活动 Pi Session；SQLite 写事务不跨模型等待。同一人物的后台提案使用 CAS 和证据时序检查，不能覆盖较新的明确纠正。

Pi 的默认自动压缩仍关闭。应用把版本化摘要和消息投影通过公开 API 接入 Pi，原文保持独立。不能直接替换 agent.state.messages，也不能忽略 SQLite / Pi 关联不一致。聊天重启不自动重发未知结果；后台整理依据持久批次和检查点重试。

## 检查

```powershell
npm run check
npm test
```

测试使用临时目录、SQLite 和本地 HTTP，不调用外部模型、不消费生产凭据。重点覆盖：

- auto-memory-store：v5 备份迁移、稳定序号、批次覆盖、租约、画像 CAS/时间、绑定和 Topic 向量；
- auto-memory：聊天与整理并行、快速连发问答、50轮续聊、85%及硬上限、长批次恢复、预算画像和服务重启；
- memory-provider：真实 Pi SDK 请求、思考关闭、独立输出预算、取消、严格 JSON 和 Embedding 维度；
- mention-policy / qq-channel：真实 mention 字段契约、人物绑定冲突与管理权限分离；
- 既有 runtime/conversation/store/CLI：恢复、去重、原文、投递、资源隔离和明确纠正。

Mock 只验证程序契约。真实模型的人物归属、提取质量、语义改写召回以及实际 QQ @ 对象需独立联调。容量检查是带余量的估算，不等于供应商精确计数。

## 当前完成与后续边界

自动记忆 v1 和轻量自我画像的实现、配置说明及离线验证已完成，参考 [存储规则](storage.md)。v7升级会先备份旧数据库，再增加自我画像表；服务重启后使用新代码，原文和旧记忆保留。真实提取质量仍需实际互动验证。

后台每次启动的调用上限与 Embedding 配置由操作者明确设置。轻量自我画像已接入：所有成员的明确建议先保存并注入，再随记忆批次归档；没有独立关系模式、好感度或人格审批流程。Telegram、长回答合并转发、Web 工具和主动插话未在本次实现中。独立群摘要、人物 FTS/向量和删除功能已按用户决定排除。

[v0.2 基线](design/pi_evolving_companion_technical_design_v0.2.md) 与 [Shiori 参考](shiori-memory-reference.md) 保留设计来源；发生冲突时以 [记忆 v1](design/companion_memory_v1.md) 和用户最新决定为准。
