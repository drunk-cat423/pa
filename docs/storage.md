# SQLite 与 Pi 会话的存储规则

SQLite pa.sqlite 保存权威原文、消息来源、运行和投递记录，以及记忆派生数据；Pi session.jsonl 保存模型上下文与审计条目。压缩仅改变活跃模型投影，原文保持完整。两者使用 run ID / Pi entry ID 对应，不能混合恢复不同时点的文件。

## schema v16

v16增加 `auto_memory_job_retirements` 旁表，保存旧count任务退出执行队列的原因、时间及原输入/进度哈希。升级不自动退役任务。显式维护只允许在本会话首次滚动快照前，对无租约的queued/failed旧count任务执行；原任务行、成员、输入、进度、错误和已有搁置记录保持不变。已退役任务不能领取、重试或迟到提交，也不再形成deferred缺口。原文在新容量快照成功前继续完整注入；退役不推进检查点、不生成摘要、不调用模型。普通搁置任务仍保留原有缺口语义。

## schema v15（历史升级）

v15增加可见消息序列 `conversation_context_messages`、滚动摘要状态 `conversation_context_state`，以及容量任务快照 `auto_memory_context_jobs` / `auto_memory_context_job_messages`。真人入站和AI确认送达时追加上下文序号；AI生成但未确认送达不进入历史，晚送达只追加。旧可见消息一次性回填；旧群聊没有续聊摘要时保留完整历史，不能因Topic已整理而消失。

群聊和私聊复用continuationSummary；容量任务持久捕获消息边界、原摘要及版本。成功提交Topic、画像、滚动摘要与上下文水位在同一事务，失败不切换。`summaryCursor`表示最近成功快照覆盖到的位置，连续`checkpoint`不能跨越显式搁置的缺口；缺口原文另行保留并通过deferredRanges标记。旧冻结任务、输入、进度和历史水位保持原样，迁移先备份，不产生新的数量触发任务。

## schema v14（历史升级）

v14新增 `person_profile_pending_results` 与 `person_profile_revision_sources`。前者按批次/pending保存无正文处理状态、原文ID、内容哈希和画像revision，后者保留每版事实的来源关联；都没有级联删除。新提交中画像写入、处理回执和已处理active pending物理移除同事务完成，deferred保留正文。旧已归档pending、原始聊天、冻结输入和所有旧画像版本不清理；迁移仍先一致性备份。人物当前画像的总量限制及协议版本见 [记忆说明](memory.md)。

v13增加`auto_memory_job_deferrals`旁表，按job_id保存显式搁置原因、时间、冻结输入及进度哈希。失败任务原行、成员、错误、原文及JSON不改写；领取和提交均排除搁置项，普通失败继续阻塞。`completed_seq`仍是连续已整理水位，不能越过搁置缺口；`summary_job_id`可能指向后续已完成批次，使用摘要时需同时标明`deferredRanges`。搁置项不能普通retry或迟到提交，不通过伪造done清除积压。

Node 内置 node:sqlite，WAL、外键、FULL 同步及 busy timeout。升级旧库会在同目录创建 pa.sqlite.v版本.UUID.bak 一致性备份，再事务迁移。未知非空库、外键损坏或更高版本会停止打开。v11增加每轮准备回执、群规则修订、个人pending用途、Topic全文索引及向量调用标记，保留已有聊天、记忆、固定批次和计数水位。

v12新增self_profile_reclassifications审计表。升级只增加结构，不猜测或自动搬运资料；本地维护时以明确的pending ID、预期原文、目标key和画像版本调用reclassifySelfProfileTerms。来源必须属于该群已绑定维护者，目标群只能是原消息所在群。迁移在同一事务新增群规则、画像投影修订及关联审计；保留原始messages、旧pending正文及所有旧修订，旧条目不再进入活跃AI画像。与现行群规则冲突、容量超限、版本变化或已归档内容不明确时整批拒绝，不覆盖新规则或猜测改写归档文字。冻结的后台输入和进度不由此操作改写，已转入群规则的来源不能再次作为AI画像证据。

| 记录 | 内容 |
|---|---|
| rooms / actors / conversations | 房间四维路由、房间内发言身份、Pi 文件映射，保留已有 ID |
| messages / message_ingest_order | 原文、独立模型输入、发送时间、接收时间、单调入库序号；平台事件在会话内唯一 |
| agent_runs / deliveries | 输入/回复、Pi 关联、完成/失败及 sent/uncertain 投递 |
| delivery_parts | 实际发送的分段正文、序号、pending/sending/sent/rejected/uncertain 状态与平台消息 ID |
| memories / memory_revisions / memory_events / memory_uses | 既有显式记忆、版本、来源与使用审计；旧删除墓碑保留 |
| persons / person_bindings / actor_person_bindings | 通用人物、明确路由身份绑定；兼容迁移 primary_person_bindings |
| person_profile_revisions | 当前人物画像版本和事实证据，旧版本保留 |
| person_profile_pending_results / person_profile_revision_sources | pending无正文处理回执、每版事实的完整来源关联 |
| self_profile_revisions | AI全局自我画像及来源消息ID，内容或来源有变化时追加版本 |
| self_profile_pending | 所有成员明确提出的AI画像建议、原消息ID、归档版本与时间；按来源幂等 |
| self_profile_reclassifications | 旧AI画像待整理条目迁入原群规则的来源、目标规则版本、前后画像修订及时间；旧条目保留，活跃投影排除 |
| auto_memory_checkpoints | 旧批次起始水位、连续成功位置及摘要来源，保留兼容审计 |
| conversation_context_messages / conversation_context_state | 持久可见消息顺序、当前滚动摘要及摘要覆盖位置、连续检查点和版本 |
| auto_memory_context_jobs / auto_memory_context_job_messages | 容量压缩的原摘要版本、固定可见边界和全部消息成员 |
| auto_memory_jobs / auto_memory_job_messages | 固定任务成员、状态、租约、输入快照和子批次进度 |
| auto_memory_job_retirements | 旧count执行任务的退役原因、时间、冻结输入/进度哈希；不表示原文已压缩 |
| memory_topics / memory_topic_messages | Topic 正文、版本、hash 及全部原消息来源 |
| person_fragments / person_fragment_messages | 人物片段、自述/转述/推断类型及消息来源 |
| topic_embeddings | 历史向量数据保留；当前无读写或派发入口 |
| memory_topic_fts | Topic摘要中文分词FTS5/BM25索引；不索引人物画像 |
| topic_embedding_attempts | 历史向量派发标记保留；当前不读取或派发 |
| person_profile_pending | 同一人物的稳定画像补充；旧purpose=memory记录保留但不进入当前投影/归档 |
| turn_preparations | 来源消息级准备计划和持久化回执；一条消息不能重复提交不同操作集合 |
| room_rule_revisions | 本群术语、规则的key与修订、来源原文ID；和人物/AI画像分开 |

没有独立群摘要或人物向量/FTS 表。人物原文来源仍带 room，已明确绑定的 person 画像跨场景共同使用。姓名相同不自动绑定，owner 授权独立。

## 入站、对话与投递

渠道消息先去重入库，然后按房间排队回复，同时通知后台调度。启动 run 时只有匹配会话、事件、发送者、原文且没有既有 run 的消息才可复用，不能把普通事件重放变成第二次模型调用。

同一个模型任务的Pi文件保持单写，房间可有独立任务并发，受统一并发预算限制。后到的提问可能在前一回答生成之前入库，构造历史时按提问边界选择完整问答，保留更早提问的已发送回复。

渠道第一模型请求返回prepare_turn计划，应用从SQLite来源消息和可信policy核验身份，在一个事务写入所有pending/群规则/群记忆和回执。任一失败全部回滚；保存成功后回答失败仍保留已经提交的数据。source_message_id作为幂等锚，不仅依赖模型生成的call ID。私聊/群聊人物共享不会赋予owner权限。

回复及 completed 状态与 pending 投递一并提交后才能发送。sent 仅表示发送端接受，不表示人已阅读。明确拒绝/结果未知保持未确认语义，不自动重发。

分段计划先整体入库，每段在网络请求前写入 sending，收到回执后逐段确认；全部成功才将父投递标为 sent。一段拒绝或未知会停止后续投递，父投递标 uncertain，重启将剩余 pending/sending 段标 uncertain，不自动续发。messages 保存完整模型原文，delivery_parts 保存转纯文本、追加参考链接后的实际文本；引用已确认发送的分段时返回该段实际文本，即使父投递未完全成功。

恢复时核对 pa_run 标记、原文或 model_input_text 与 Pi entry：有可验证回复则补齐 SQL；无回复标 interrupted；pending 投递改 uncertain；已关联历史不一致则停止。平台原文不会被模型输入 JSON 替代。

## 后台事务与检查点

群聊和私聊仅在最终上下文含输出预留达到实际窗口85%时创建容量批次，不按消息或问答数量自动触发。任务固定原摘要及版本、可见边界和全部待压缩消息ID；后台处理中到达的新消息或晚送达回复追加在边界之后，留到后续上下文，不改变本次快照。

模型等待不持有写事务。提交事务同时验证租约、来源、人物及摘要版本和证据时序，并落地Topic、人物片段、画像、会话摘要及检查点。只有完整提交后才切换摘要和推进连续成功位置；向量执行逻辑已移除，历史表保留。

过长批次保存可恢复的子批次结果，显式重试续接已成功部分。画像冲突使旧提案失效，人工重试重新读取当前版本；普通失败不改写冻结输入。关闭中断、崩溃租约过期和未知调用均保留failed状态，需通过任务CLI明确重排，不静默重复付费。旧input/progress缺少purpose时按profile等价处理；包含个人memory协议时明确停止，不改写历史JSON。

新批次捕获本房间已经落库的待整理条目，即使条目的来源在更早冻结批次中也能归档。旧个人事件协议不再执行或迁为画像；冻结JSON保留并报告过期诊断。人物画像共享仍按既有规则。Topic召回关联片段时只返回该Topic自身消息ID。

自我画像合并和pending归档属于同一记忆提交事务。任务捕获全局版本及待整理ID，模型只能归档该快照内保留来源的条目；并发新增不归档。不同房间使用全局版本检查解决冲突。模型结果与提交时当前pending一起检查完整结构容量，超限或版本冲突保留原数据并重读重试。旧版在途任务缺少selfProfile输入时继续原流程，不伪造自我画像提案。

升级保留旧任务和历史水位，不在启动时对所有旧会话发起模型请求。旧摘要先保留，原始可见历史也保守保留，直到新协议的完整容量快照成功后再切换；当前请求因旧历史达到容量线时才创建整理任务。

## 原文、纠正与上下文

不提供删除操作。平台撤回不删除记录；旧版本的 deleted 记录不恢复正文。明确纠正保留版本，新偏好替代当前值，过去经历仍能回溯。

已使用的显式记忆被纠正或失效时，SQL 标记上下文待重置；通过 Pi appendContextEdit / refreshContext 持久化活跃投影后确认代次。SQL 与 Pi 不能跨文件原子提交，失败保持 pending 并在下一次打开时恢复。

渠道会话每次按SQL、当前画像、已生效会话摘要和Topic重建投影；后台不在聊天期间改写活动Session。群聊与私聊的滚动摘要均由应用保存，Pi自带compaction/branch_summary仍不启用；导入包含这些条目的历史会按现有保护停止处理。

## 备份和诊断

自动迁移备份只涵盖 SQLite。完整恢复前需正常停止服务并备份整个 PA_DATA_DIR，同时保存 Pi JSONL；不要分别恢复不同时点的数据库与 Pi 文件。

```powershell
npm start -- history --conversation owner --limit 20
node --env-file-if-exists=.env dist/memory-jobs-cli.js status
node --env-file-if-exists=.env dist/memory-jobs-cli.js retry JOB_ID
```

任务状态不输出消息正文、画像或凭据。运行数据、备份、密钥、构建输出均不提交到 Git。启用配置与验证边界见 [memory.md](memory.md)。
