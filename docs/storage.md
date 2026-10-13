# SQLite 与 Pi 会话的存储规则

SQLite pa.sqlite 保存权威原文、消息来源、运行和投递记录，以及记忆派生数据；Pi session.jsonl 保存模型上下文与审计条目。压缩仅改变活跃模型投影，原文保持完整。两者使用 run ID / Pi entry ID 对应，不能混合恢复不同时点的文件。

## schema v7

Node 内置 node:sqlite，WAL、外键、FULL 同步及 busy timeout。首次打开 v1–v6 会在同目录创建 pa.sqlite.v版本.UUID.bak 一致性备份，再事务迁移。未知非空库、外键损坏或更高版本会停止打开。v6升级v7仅增加自我画像表，保留已有后台批次和计数水位。

| 记录 | 内容 |
|---|---|
| rooms / actors / conversations | 房间四维路由、房间内发言身份、Pi 文件映射，保留已有 ID |
| messages / message_ingest_order | 原文、独立模型输入、发送时间、接收时间、单调入库序号；平台事件在会话内唯一 |
| agent_runs / deliveries | 输入/回复、Pi 关联、完成/失败及 sent/uncertain 投递 |
| memories / memory_revisions / memory_events / memory_uses | 既有显式记忆、版本、来源与使用审计；旧删除墓碑保留 |
| persons / person_bindings / actor_person_bindings | 通用人物、明确路由身份绑定；兼容迁移 primary_person_bindings |
| person_profile_revisions | 当前人物画像版本和事实证据，旧版本保留 |
| self_profile_revisions | AI全局自我画像及来源消息ID，内容或来源有变化时追加版本 |
| self_profile_pending | 所有成员明确提出的AI画像建议、原消息ID、归档版本与时间；按来源幂等 |
| auto_memory_checkpoints | 起始历史水位、连续成功位置、私聊续聊摘要及其来源任务 |
| auto_memory_jobs / auto_memory_job_messages | 固定任务成员、状态、租约、输入快照和子批次进度 |
| memory_topics / memory_topic_messages | Topic 正文、版本、hash 及全部原消息来源 |
| person_fragments / person_fragment_messages | 人物片段、自述/转述/推断类型及消息来源 |
| topic_embeddings | Topic 当前版本的模型、维度、输入版本、hash 与向量 |

没有独立群摘要或人物向量/FTS 表。人物原文来源仍带 room，已明确绑定的 person 画像跨场景共同使用。姓名相同不自动绑定，owner 授权独立。

## 入站、对话与投递

渠道消息先去重入库，然后按房间排队回复，同时通知后台调度。启动 run 时只有匹配会话、事件、发送者、原文且没有既有 run 的消息才可复用，不能把普通事件重放变成第二次模型调用。

同一个 conversation 最多一个 running 聊天调用；不同房间独立。后到的提问可能在前一回答生成之前入库，构造历史时按提问边界选择完整问答，保留更早提问的已发送回复。

回复及 completed 状态与 pending 投递一并提交后才能发送。sent 仅表示发送端接受，不表示人已阅读。明确拒绝/结果未知保持未确认语义，不自动重发。

恢复时核对 pa_run 标记、原文或 model_input_text 与 Pi entry：有可验证回复则补齐 SQL；无回复标 interrupted；pending 投递改 uncertain；已关联历史不一致则停止。平台原文不会被模型输入 JSON 替代。

## 后台事务与检查点

群聊按真人消息计数，私聊按成功且已确认发送的完整问答计数。任务固定消息 ID 和序号，已占用消息不再次计入新批次；不能用最大序号差值代替数量。

模型等待不持有写事务。提交事务同时验证租约、来源、人物版本和证据时序，并落地 Topic、人物片段、画像及私聊检查点。只有完整提交后才推进连续成功位置；Embedding 独立重试，不重复创建 Topic。

过长批次保存可恢复的子批次结果，已成功子批次不在普通重试时重复调用模型。画像冲突会清除旧提案快照，重新读取当前版本。关闭中断重新排队；崩溃由租约到期后接续。失败达到上限需通过任务 CLI 重排。

自我画像合并和pending归档属于同一记忆提交事务。任务捕获全局版本及待整理ID，模型只能归档该快照内保留来源的条目；并发新增不归档。不同房间使用全局版本检查解决冲突。模型结果与提交时当前pending一起检查完整结构容量，超限或版本冲突保留原数据并重读重试。旧版在途任务缺少selfProfile输入时继续原流程，不伪造自我画像提案。

升级起始水位防止数量触发立即回填全部旧历史。当前请求因旧历史达到容量线时，可以按固定容量批次整理活跃历史；不在启动时对所有旧会话发起模型请求。

## 原文、纠正与上下文

不提供删除操作。平台撤回不删除记录；旧版本的 deleted 记录不恢复正文。明确纠正保留版本，新偏好替代当前值，过去经历仍能回溯。

已使用的显式记忆被纠正或失效时，SQL 标记上下文待重置；通过 Pi appendContextEdit / refreshContext 持久化活跃投影后确认代次。SQL 与 Pi 不能跨文件原子提交，失败保持 pending 并在下一次打开时恢复。

渠道会话每次按 SQL、当前画像、已生效摘要和 Topic 重建投影；后台不在聊天期间改写活动 Session。私聊模型摘要由应用保存，Pi 自带 compaction/branch_summary 仍不启用；导入包含这些条目的历史会按现有保护停止处理。

## 备份和诊断

自动迁移备份只涵盖 SQLite。完整恢复前需正常停止服务并备份整个 PA_DATA_DIR，同时保存 Pi JSONL；不要分别恢复不同时点的数据库与 Pi 文件。

```powershell
npm start -- history --conversation owner --limit 20
node --env-file-if-exists=.env dist/memory-jobs-cli.js status
node --env-file-if-exists=.env dist/memory-jobs-cli.js retry JOB_ID
```

任务状态不输出消息正文、画像或凭据。运行数据、备份、密钥、构建输出均不提交到 Git。启用配置与验证边界见 [memory.md](memory.md)。
