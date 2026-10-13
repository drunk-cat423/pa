# SQLite 与 Pi 会话的存储规则

## 各自负责什么

SQLite `pa.sqlite` 保存本阶段开始接收的原始业务消息、模型运行结果与投递状态。Pi `session.jsonl` 保存模型上下文、系统提示词与运行条目。二者都在 `PA_DATA_DIR`，默认 `.local/pa`。

SQLite 原文用于记忆来源与审计；Pi 上下文用于继续聊天，不能用压缩摘要覆盖业务原文。显式记忆单独保存，当前未启用自动压缩或工具。

采用 Node 24.15.0 的 `node:sqlite`，没有第三方驱动。连接启用外键、WAL、FULL 同步和 5 秒 busy timeout。schema 当前为 `user_version=5`，事务迁移 v1/v2/v3/v4 并在迁移前后验证外键；失败回滚，未知非空数据库或更高版本不自动改造。

## schema v5

| 表 | 关键记录与约束 |
|---|---|
| actors | 本机 CLI owner，以及按 room/渠道 senderId 唯一的外部成员；不推断跨群身份 |
| primary_person_bindings | 本地明确配置的完整 route + senderId → person_id；与管理权限分离 |
| rooms | channel/account/room_type/external_chat_id 四项唯一，CLI 保留 cli/local/private |
| conversations | 内部 UUID、room 外键、固定 Pi session 文件路径 |
| messages | UUID、conversation、sender、chat/memory 类型、原文、独立模型输入、事件 ID、Pi entry ID、时间；外部事件在会话内唯一 |
| agent_runs | UUID、输入/输出消息引用、供应商/模型、状态、错误类别、恢复标记 |
| deliveries | 回复/运行引用、实际 channel/room、外部发送 ID、pending/sent/uncertain；每轮最多一个记录 |
| memories / memory_revisions | 当前记忆、版本及生效/删除状态，room/actor/legacy 范围、人物 ID、被描述者/初始写入者/画像字段、当前标记、发生/到期时间、实际来源 |
| memory_events / memory_uses | 明确操作的审计元数据、每轮召回版本引用 |
| memory_context_state | 待执行模型上下文重置、代次与 SQL 背景水位 |

同一个 conversation 最多一个 running 调用。用户消息和 run 一起事务提交；回复、completed 状态和 pending 投递一起事务提交。失败回滚，不记录伪造的成功回复。

普通全量群消息只记录原文和成员，没有模型 run 或 Pi entry。@ 触发的模型输入包含当前发送者和有限同群背景，SQLite 原文保持不变；恢复按独立 model_input_text 对应 Pi。事件在模型请求前入库，重复到达或重启不重试收费请求。

日常聊天采用增量写入：每条收到的有效文本在 `messages` 插入一行，每条 AI 回复再插入一行；运行和投递只更新对应状态，不每次复制全部历史。Pi `session.jsonl` 首次创建后按条目逐行追加，正常聊天不每轮重写文件；特殊的 SDK 文件升级或分支操作可重写文件，本项目未在日常聊天中调用这些操作。

当前完整留存范围为机器人在线期间从白名单房间收到的有效文本及自身回复；不回填接入前 QQ 历史，不存附件二进制，空消息、超出 4000 字符和机器人回声被过滤。原文尚无自动过期清理。渠道模型每轮从水位后的有效记录重建活跃投影：最多 8 条普通文本与当前发送者最近最多 12 条 AI 交互，再分别注入房间记忆、当前人物长期记忆、相关画像，合计最多 8 条。记忆到期退出召回，正文仍留审计；其他人的 AI 交互、管理命令与查询结果不注入。

只有 primaryPerson 明确绑定的用户本人跨房间共享个人长期记忆/画像，普通成员按 room + actor 隔离；群共享记忆、原始 messages 和 Pi 文件仍按房间保存。跨场景个人记录修改保留原始归属与初始作者，事件和新版本的来源记录实际操作房间，并重置全部相关房间背景水位；不全量复制历史。解绑不让原 person_id 记录退回房间范围。

管理运行 provider=local、model=memory-control，不调用模型。同一事务提交实际消息来源、记忆与审计、回复和待投递记录；嵌套 CRUD 用 SAVEPOINT，投递前持久化失败整笔回滚。相同事件重放不会再次更新或重发。应用层删除清空记忆版本正文并重置上下文，原始聊天与 Pi 审计条目仍保留。

## 一轮对话

```text
SQLite：用户原文 + running
    ↓
Pi：custom pa_run 标记（run ID）→ 用户消息 → 模型回复
    ↓
SQLite：关联 Pi entry ID + 回复 + completed + pending 投递
    ↓
终端输出流接受回复 → sent；输出失败 → uncertain
```

`pa_run` 是 Pi 的普通 custom entry，保存于会话文件但不注入模型上下文，不修改缓存前缀。`sent` 对 CLI 表示本地输出流接受内容，对 QQ 表示官方 API 返回发送消息 ID，没有已读含义。发送失败、响应损坏或网络结果未知不重发，投递留为 `uncertain`；transport 另报告明确 `rejected`。

同一会话锁从打开 Pi 到业务记录处理完毕一直持有。关闭先中止模型、等待调用状态落库，再释放锁和关闭数据库。数据库持久化失败会停止该会话，保留可供恢复的记录，不继续产生未记录回复。

## 重开时的核对

| 上次停止位置 | 本次行为 |
|---|---|
| SQL 已记录输入，Pi 没有完整回复 | 标记 interrupted，不自动请求模型 |
| Pi 有匹配 run ID、原文及正常完整回复，SQL 仍 running | 补齐回复与 completed，标记 recovered |
| Pi 留下 error / aborted | 记录 failed / interrupted，不造成功回复 |
| 输入或 run 标记不能唯一匹配 | 标记 interrupted，保留原始记录 |
| 已关联的 SQL 消息与 Pi entry 缺失或原文不同 | 停止打开，保留两份数据供核查 |
| 回复已入库但没有输出确认 | pending 转 uncertain，不重发 |
| 投递已 sent | 保留 sent，不重发 |

核对仅作用于当前会话；其他会话的数据不变。正常回复的 SQL 写入失败时，run 保持 running，供下次从 Pi 核对。模型错误信息在业务层隐藏 API 密钥与本轮输入后保存。

## 查看和备份

交互中 `/history` 查询当前会话最近 20 条业务消息。离线查询不需要模型配置：

```powershell
npm start -- history --conversation owner --limit 20
```

输出带有消息角色、Pi entry ID、运行和投递状态。旧版本已有的 Pi 历史继续用于模型上下文，不自动回填为已审计的业务原文。

备份前正常退出所有使用该数据目录的 CLI，再复制整个 `PA_DATA_DIR`，同时保留数据库、可能存在的 WAL 文件和各会话 JSONL。不要分别恢复来自不同时间的数据库与 Pi 文件。若上次强制退出留下锁，确认原进程已结束后再移除该锁；核对流程会在重新打开会话时执行。

显式记忆由 [记忆服务](memory.md) 管理；原始消息删除、自动后台备份、保留期限和跨平台身份自动绑定尚未实现。QQ 内完整记忆管理只给本地绑定的 owner，普通用户仅可更新本人本群明确提供的信息。
