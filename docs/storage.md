# SQLite 与 Pi 会话的存储规则

## 各自负责什么

SQLite `pa.sqlite` 保存本阶段开始接收的原始业务消息、模型运行结果与投递状态。Pi `session.jsonl` 保存模型上下文、系统提示词与运行条目。二者都在 `PA_DATA_DIR`，默认 `.local/pa`。

SQLite 原文用于记忆来源与审计；Pi 上下文用于继续聊天，不能用压缩摘要覆盖业务原文。显式记忆单独保存，当前未启用自动压缩或工具。

采用 Node 24.15.0 的 `node:sqlite`，没有第三方驱动。连接启用外键、WAL、FULL 同步和 5 秒 busy timeout。schema 当前为 `user_version=2`，在锁内事务迁移 v1；未知非空数据库或更高版本不自动改造。

## schema v2

| 表 | 关键记录与约束 |
|---|---|
| actors | 当前只有本机 CLI owner，不代表跨平台认证身份 |
| rooms | cli / local / 外部会话名称，三项唯一 |
| conversations | 内部 UUID、room 外键、固定 Pi session 文件路径 |
| messages | UUID、conversation、sender、user/assistant、原文、Pi entry ID、时间 |
| agent_runs | UUID、输入/输出消息引用、供应商/模型、状态、错误类别、恢复标记 |
| deliveries | 回复/运行引用、pending/sent/uncertain；每轮最多一个投递记录 |
| memories / memory_revisions | 当前记忆、版本及生效/删除状态，来源事件和可选用户消息引用 |
| memory_events / memory_uses | 明确操作的审计元数据、每轮召回版本引用 |
| memory_context_state | 待执行模型上下文重置及代次 |

同一个 conversation 最多一个 running 调用。用户消息和 run 一起事务提交；回复、completed 状态和 pending 投递一起事务提交。失败回滚，不记录伪造的成功回复。

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

`pa_run` 是 Pi 的普通 custom entry，保存于会话文件但不注入模型上下文，不修改缓存前缀。`sent` 只表示本地输出流接受了内容，没有已读含义，也不承诺跨平台 exactly-once。

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

显式记忆的删除/纠正由 [记忆服务](memory.md) 管理；原始消息删除、后台备份、保留期限和渠道身份认证尚未实现。
