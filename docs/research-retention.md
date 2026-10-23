# 研究材料保留与清理

入口：`scripts/deployment/research-retention.mjs`。使用 Node 自带 SQLite/文件接口，不加载模型配置，不调用模型或连接 QQ。当前只交付本地实现、预览和离线验证；未安装服务器定时器，也未删除服务器数据。

## 规则

- 仅对 `completed` 且有固定 workflow plan 的任务考虑清理。未完成状态（queued/running/partial/blocked/failed/interrupted）全部保留，即使已经移出清单也不清理其恢复进度。
- 完成时间取当前 completed attempt 与 task.updated_at 的较晚值；已经归档时再与归档时间取较晚值。满 30×24 小时才进入候选，未来或无法解析的时间不放行。
- 有运行中的周期、批次或尚在 sending 的投递不清理。没有固定计划的旧 completed 任务仍可能支持续作，本版保守跳过。
- 保留所有报告版本的 MD/TXT、当前章节/单答复正文、任务目标、计划、状态、模型用量、投递和版本审计、原始聊天与人物/记忆数据。
- 清理 research_evidence 正文、workflow/collection 周期的输入正文及 collection 结果正文，以 `retained:false`、原 SHA-256、原字节数及 cleanupId 替代。原 input_hash 仍指向被清理的原始输入；墓碑不是新的模型输入。
- 只删除有版本元数据、被当前正文替代的旧章节 `.md` 文件；版本/review 行及哈希仍保留。未知或孤儿文件、目录不删除，不递归删除整个任务。
- Pi JSONL、通用 diagnostics、图片、备份不在本轮清理范围；它们可能包含重复材料，因此本功能不是全盘日志清理。备份继续遵循独立轮换政策。

## 只读预览

```powershell
node scripts/deployment/research-retention.mjs preview <数据目录> > cleanup-preview.json
```

只接受 schema27，不调用 ConversationStore 初始化、不迁移旧库、不写清理审计或业务行。SQLite 的只读 WAL 连接可能更新共享内存锁信息（`-shm`），这不是业务数据修改。

预览包含数据库路径/文件身份、生成时间、候选任务、起算时间、精确旧文件路径/哈希/字节数、必须保留的文件、状态/内容哈希和跳过原因。不输出原始聊天或材料正文。

常见跳过原因：`unfinished_protected` 未完成、`retention_30_days` 未满30天、`active_work_protected` 有活动状态、`legacy_without_fixed_plan_protected` 旧协议、`missing_or_unsafe_artifacts` 文件缺失/哈希异常/链接路径、`cleanup_pending` 等待恢复、`already_cleaned` 已清理。

`fileBytes` 是候选旧文件的字节数；`databasePayloadBytes` 是被替代的数据库正文总量，尚未扣除墓碑记录，不等于立即释放的磁盘空间。SQLite 清理后页面可被复用，主库文件不一定马上缩小；本工具不执行 VACUUM。

## 显式执行与中断恢复

以下命令会实际清理，仅在预览审核并明确启用后使用；本轮只在临时测试库执行：

```powershell
node scripts/deployment/research-retention.mjs apply <数据目录> cleanup-preview.json
```

新计划须在24小时内且不能来自未来。`BEGIN IMMEDIATE` 内从当前数据重新推导清单，拒绝被修改的计划、过期任务状态、文件或正文指针变化；先核验全部保留报告和当前正文。清理路径任何层级的符号链接、非常规文件、硬链接都拒绝。

数据库正文替代与维护专用表 `research_retention_runs` 的 pending 清单同事务提交。这张附属表仅首次 apply 创建，不修改应用 user_version，不参与模型工具协议。表内仅保留无正文的冻结清单、前后哈希及状态。提交失败不碰文件；提交成功后再按持久清单逐个核验并删除旧文件，全部结束才标记 done。

进程中断后重放同一预览可恢复 pending；仅已提交清单中的缺失文件视为已删，内容被替换则停止。正常领取最终报告或之后归档不会使恢复失效，执行状态/正文/材料变化仍严格拦截。重复执行 done 返回幂等回执。失败不会影响 bot 正常聊天，不会触发收费重试。

## 自动模式（尚未启用）

```powershell
node scripts/deployment/research-retention.mjs run <数据目录> --apply
```

自动模式先恢复已提交的 pending，再生成当下的新预览并按相同校验执行；没有候选则不写审计。只有明确的 `--apply` 才允许自动删除。

`pa-research-retention.service` / `.timer` 模板每天服务器时间04:45运行，默认 ExecStart 是 **preview**，与部署备份共用 `/run/lock/pa-storage.lock`。模板未安装/启动。以后启用自动删除时须显式将命令改成 `run /var/lib/pa --apply`；不能在本轮部署时顺带切换。手工维护同样应持有该锁，避免与整目录备份/代码切换交叉。

## 验证边界

`test/research-retention.test.mjs` 在临时数据库/文件中执行：年龄边界、归档未完成保护、原始聊天与人物表不变、只读预览、报告及当前正文哈希保留、墓碑审计、过期/篡改/路径拒绝、事务回滚、删到一半恢复、报告领取后恢复及重复执行。模拟数据不代表服务器当前占用或回收量；未验证 Linux systemd 实际运行。
