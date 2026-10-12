# Shiori 记忆设计与 TypeScript 实现路线

Shiori 是设计参考，不是 pa 的运行依赖。用户已明确：项目以 TypeScript 为主，借鉴记忆思路，独立实现，不移植 Python 程序。

2026-10-12 复核其[记忆领域说明](https://github.com/YinFengWindy/Shiori-Agent/blob/main/docs/knowledge/modules/memory.md)，本次读取的 `last_verified_commit` 为 `bdfdae59`。参考契约与存储分层、回合前召回、显式操作共用契约、查询作用域过滤；没有复制源码，也没有采用其完整插件/向量管线。

| 参考思路 | pa 的 TypeScript 路线 | 阶段 |
|---|---|---|
| 查询、变更与生命周期分开 | MemoryQuery / MemoryService 表达业务语义，存储实现单独负责 SQLite | 显式记忆 |
| 显式记住、召回、遗忘共用契约 | 管理 CLI 和批准的 Agent 工具调用同一服务；纠正和删除可验证 | 显式记忆 |
| 召回在回合前发生 | Context Builder 注入有权限的有限记忆块 | 显式记忆 |
| 记忆域显式过滤 | SQL 按 private_actor / group_room / self_global / public 过滤，再检索 | 显式记忆 |
| 证据与检索分数分离 | 保存来源和状态；召回得分不覆盖事实证据 | 显式记忆 |
| 回合后提取不阻塞投递 | 消息成功记录后排队提取，候选与正式记忆分开 | P1 |
| 提取/整理共享去重背景和预算 | 有限候选、去重、冲突检测、supersede，记录失败原因 | P1 |
| 向量召回和 HyDE 等策略 | 先用 scope + 关键词/FTS5，确有需要时再评估语义检索 | 后续可选 |

目前实际接口为 `MemorySession` / `RecordedConversation`，共用 `ConversationStore` 的四操作；`memory-types.ts` 定义契约。SQL 先按当前 conversation 过滤，使用字面子串查询，聊天未命中时召回最近记忆。最多注入 8 条完整记录、8000 字符 JSON 块，并记录版本引用。跨平台 private_actor / group_room / self_global / public 是后续范围，未作为当前已实现功能。

pa 的额外要求是多人隐私、删除与自我模型证据链。不能直接沿用其他项目的群体信息共享策略；私聊事实不自动成为全局人格属性，撤回事实时必须处理派生记忆及自我模型证据。

纠正保留版本审计，删除清空记忆正文，并通过待执行重置使旧 Pi 活动上下文失效。原始聊天和备份保留；自动提取、整理、向量检索和自我模型仍未实现。具体规则见 [memory.md](memory.md)。
