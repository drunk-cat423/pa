# 研究材料保留与清理

入口：`scripts/deployment/research-retention.mjs`。使用 Node 自带 SQLite/文件接口，不加载模型配置，不调用模型或连接 QQ。服务器已于2026-10-23经单独授权启用实际模式；用户随后授权将到期清理扩展至正式报告和当前正文。

## 规则

- `completed` 任务（包括无固定计划的旧任务）满30天后清理报告和材料。`failed` 仅在已移出清单（归档）满30天后可清理，无计划或无正式报告也适用；仍在清单内的失败任务全部保留。其余未完成状态（queued/running/partial/blocked/interrupted）即使归档也保留恢复进度。
- 完成时间取当前 completed attempt 与 task.updated_at 的较晚值；归档不延长成功任务保留期。满30×24小时才进入候选，未来或无法解析的时间不放行。
- 失败任务以归档时间起算30×24小时，并核对当前批次也是failed。新预览带policy标记`research-content-and-evidence-30d-v4`，旧未提交预览必须重新生成；已提交旧pending清单按原范围恢复，再由新预览清理剩余到期报告/正文。旧done记录允许升级清理，已清文件须有原清单哈希证明，既有墓碑不重复替换。
- 有运行中的周期、批次或尚在sending的投递不清理。清理过的任务不能继续执行；需要重新研究时创建新任务。
- 到期删除所有有元数据的正式报告MD/TXT、当前正文及旧稿。保留任务目标、计划、状态、失败原因、模型用量、报告摘要/关键词、投递和版本元数据/哈希、原始聊天与人物/记忆数据。读取或发送已过期报告会明确提示已清理；不会创建投递回执或冒充文件损坏。报告读取、文件投递预约和工作流正文载入与清理用数据库事务互斥。
- 清理 research_evidence 正文、workflow/collection 周期的输入正文及 collection 结果正文，以 `retained:false`、原 SHA-256、原字节数及 cleanupId 替代。原 input_hash 仍指向被清理的原始输入；墓碑不是新的模型输入。
- 到期任务只删除有版本元数据且哈希核验通过的报告与章节文件。版本/review行及哈希仍保留。未知或孤儿文件、目录不删除，不递归删除整个任务。
- 研究专属诊断正文和Pi会话纳入同一规则，见下节。普通聊天/整理的Pi会话及diagnostics、共享事件日志、图片、备份不在本轮清理范围；它们可能包含重复材料，因此本功能不是全盘日志清理。备份继续遵循独立轮换政策。

正式报告更新另有“只留最新正文”规则：新版本文件和latest_version提交成功后，旧版MD/TXT即被替换清理，旧报告行与哈希仍保留。30天清理预览接受已被更高版本替换的旧文件缺失；未知缺失与当前版本缺失仍拒绝。研究材料、章节检查点和日志不随正式报告更新即时删除。

## 研究诊断与 Pi 会话

2026-10-23已完成离线回归与服务器只读预览，用户随后授权部署v4并继续保持30天到期实际清理；普通聊天和未完成恢复资料仍排除，不重试历史失败收费任务。

- 调用归属须同时匹配诊断索引和记录中的taskId、原conversationId、runId/traceId及callId；仅允许研究chat/search调用。清单逐一记录request/response/input引用的路径、哈希与字节数，未知/孤立文件不按目录删除。
- 保留diagnostics/index.sqlite的调用及事件记录和按日events JSONL，包括失败阶段、错误类别、SDK/接口token用量、原引用哈希。只删除所核验的正文文件，不改写索引，不清理共享事件文件。
- Pi候选从任务全部attempt及workflow/collection cycle派生，包括旧键research:<taskId>:<attempt>和周期键research:<taskId>:<attempt>:cycle:<cycle>。目录必须为键的SHA-256，session内全部pa_run均须对应同任务诊断调用；普通conversations/agent_runs登记的会话排除。仅删除session.jsonl，不删除目录或锁。
- 会话存在锁则延期整个任务；缺少标记或标记不符的文件列入evidence.excluded保留，需另行核查。并不声称可定位无记录的历史会话。
- 预览及执行校验诊断索引文件身份、调用元数据快照与正文哈希；新调用或索引变化拒绝旧计划。主库维护审计先提交，再删除文件；中断恢复只接受原清单已记录的缺失文件。旧v1-v3清单按原范围恢复，之后v4补清可确认归属的副本。
- 已提交pending/done清单中的诊断正文立即标识为过期，内容读取/离线重放明确提示已清理；调用元数据查询仍可用。不依据缺文件猜测过期，不创建/迁移业务数据库，不触发模型补录。

## 只读预览

```powershell
node scripts/deployment/research-retention.mjs preview <数据目录> > cleanup-preview.json
```

只接受 schema27，不调用 ConversationStore 初始化、不迁移旧库、不写清理审计或业务行。SQLite 的只读 WAL 连接可能更新共享内存锁信息（`-shm`），这不是业务数据修改。

预览包含数据库路径/文件身份、生成时间、候选任务、起算时间、精确旧文件路径/哈希/字节数、必须保留的文件、状态/内容哈希和跳过原因。不输出原始聊天或材料正文。

常见跳过原因：`unfinished_protected` 未完成、`retention_30_days` 未满30天、`active_work_protected` 有活动状态、`active_research_session` 研究会话有锁、`missing_or_unsafe_artifacts` 文件缺失/哈希异常/链接路径、`cleanup_pending` 等待恢复、`already_cleaned` 已按当前策略清理。

`fileBytes` 是候选旧文件的字节数；`databasePayloadBytes` 是被替代的数据库正文总量，尚未扣除墓碑记录，不等于立即释放的磁盘空间。SQLite 清理后页面可被复用，主库文件不一定马上缩小；本工具不执行 VACUUM。

## 显式执行与中断恢复

以下命令会实际清理，仅在预览审核并明确启用后使用：

```powershell
node scripts/deployment/research-retention.mjs apply <数据目录> cleanup-preview.json
```

新计划须在24小时内且不能来自未来。`BEGIN IMMEDIATE` 内从当前数据重新推导清单，拒绝被修改的计划、过期任务状态、文件或正文指针变化；先核验全部待清文件。清理路径任何层级的符号链接、非常规文件、硬链接都拒绝。

数据库正文替代与维护专用表 `research_retention_runs` 的 pending 清单同事务提交。这张附属表仅首次 apply 创建，不修改应用 user_version，不参与模型工具协议。表内仅保留无正文的冻结清单、前后哈希及状态。提交失败不碰文件；提交成功后再按持久清单逐个核验并删除旧文件，全部结束才标记 done。

进程中断后重放同一预览可恢复pending；仅已提交清单中的缺失文件视为已删，内容被替换则停止。到期清单提交后立即停止读取/发送该清单中的正文，旧策略保留报告的正常领取不影响旧清单恢复；执行状态/正文/材料变化仍严格拦截。重复执行done返回幂等回执。失败不会触发收费重试。

## 自动模式

```powershell
node scripts/deployment/research-retention.mjs run <数据目录> --apply
```

自动模式先恢复已提交的 pending，再生成当下的新预览并按相同校验执行；没有候选则不写审计。只有明确的 `--apply` 才允许自动删除。

`pa-research-retention.service` / `.timer` 模板每天服务器时间04:45运行，默认 ExecStart 是 **preview**，与部署备份共用 `/run/lock/pa-storage.lock`。服务器当前通过已授权的`actual-cleanup.conf` drop-in将命令覆盖为 `run /var/lib/pa --apply`；后续部署应核对实际模式并保留已批准的override，不擅自切换。手工维护同样应持有该锁，避免与整目录备份/代码切换交叉。

## 验证边界

`test/research-retention.test.mjs` 在临时数据库/文件中执行：年龄边界、未完成保护、原始聊天与人物表不变、只读预览、报告/正文到期及读取保护、墓碑审计、过期/篡改/路径拒绝、事务回滚、中断恢复、旧清单升级及重复执行。模拟数据不代表服务器当前占用或回收量。
