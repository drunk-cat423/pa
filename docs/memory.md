# 显式记忆

首版参考 Shiori 的契约分层、查询域过滤和轮前召回思路，用 TypeScript 独立实现。只接受明确操作，不自动从聊天中提取，不通过 LLM 猜测删除对象。

## 四个操作

| 操作 | 行为 |
|---|---|
| remember | 保存完整正文、kind、stable ID、revision=1、explicit_user 来源及审计事件 |
| query | SQL 先限定房间/成员或明确绑定人物，再查询有效记录；关键词是字面子串，空查询列最近记录 |
| correct | 同一 ID 创建新版本；旧版本 superseded，不参与召回，保留内容供审计 |
| delete | 标记 deleted，清空当前及全部历史版本的数据库正文；只保留 ID、版本、事件等元数据 |

支持 kind：fact、preference、episode。正文保留原字符串，拒绝空白，最多 4000 Unicode 码点。query 最多 1000 码点，limit 默认 20、范围 1–200。没有语义搜索或 FTS5；`%`、`_` 按普通字符查询。

群共享记忆为 room，归当前内部 conversation ID。成员个人长期记忆与画像为 actor，保存 subject_actor_id；profile_field 为空的是事实/经历等长期记忆，有字段的是当前画像。实际写入者和来源另记 writer_actor_id、消息 ID 与操作事件。普通成员按群隔离；CLI 会话名称不代表平台认证。

用户本人由本地 policy.json 的 primaryPerson 明确关联多个 route + senderId，个人记录归统一 person_id，在已绑定私聊与群聊共同读写。ownerBindings 只决定管理权限，不自动合并人物。没有匹配绑定的身份不能读取 person_id 记录，即使名称或 senderId 相同。群共享记忆与原始聊天、Pi 会话仍按房间存储。

同步绑定会将这些准确身份既有的本人记录提升到 person_id；群共享和其他成员记录不提升。同一画像字段有多个旧自述值时，以最后更新的完整记录为当前值，其他记录标记非当前，保留正文与版本审计。解绑后不回落成该房间的公开个人记忆；新人物 ID 不继承旧人物数据。

## 群聊权限与入口

所有权限、解析、记忆操作和召回由 harness 实现，QQ 适配器不包含记忆业务。群内只有明确 @ 时执行或回复；未 @ 的管理文本不写长期记忆。白名单私聊无需 @。

本地 `PA_DATA_DIR/policy.json` 的 ownerBindings 按 channel、accountId、roomType、roomId、senderId 精确绑定管理者，启动时加载。昵称和模型输出不参与授权。缺少 policy 时没有群管理者，格式损坏时拒绝启动；新增群/平台需要明确确认绑定。

普通群友只获得统一的 update_self_profile 能力，限定自己在当前群明确提供的饮食、称呼、兴趣和回复偏好。底层分别进行新增、版本修正、删除；每个字段修改对应项，不覆盖全部画像。首次绑定及每次纠正/删除都会使旧背景失效。

支持本地明确句式，例如“请记住我不喜欢吃辣”“我现在可以接受微辣了”“请记住我的兴趣是登山”“以后请叫我小林”“忘掉我的饮食偏好”。删除目标限定明确的字段名称，第三人描述、未知字段及歧义请求请重新明确，不通过模型猜对象。更新确认只告知字段已更新，不展示旧值、清单、内部 ID 或评价。

普通群友无画像查询、列表、导出及管理权限；明确的自然语言画像读取请求和 `/memory` 等管理命令在本地拒绝，不进入模型。普通更新只能操作 subject=writer=实际发送者的自述项，不能改 owner 的内部记录、他人、群共享记忆或全局 AI 画像。AI 内部评价与全局画像演化本阶段仍未实现。

管理者可用：

```text
@机器人 /memory remember room 本群每周五晚上讨论项目
@机器人 /memory remember me 我喜欢乌龙茶
@机器人 /memory remember user:发送者ID 该成员明确提供的信息
@机器人 /memory query [关键词]
@机器人 /memory query room [关键词]
@机器人 /memory query me [关键词]
@机器人 /memory query user:发送者ID [关键词]
@机器人 /memory correct 记忆ID 新内容
@机器人 /memory delete 记忆ID
```

管理查询包含当前房间记录和本人统一身份的个人记录；room 查询只含当前房间，me 查询只含当前人物，user: 指定当前房间已出现的成员。返回内容会显示在发起操作的房间。`/remember`、`/memories`、`/correct`、`/forget` 作为同权限别名。用户记忆中的 source actor 与 subject actor 可以不同，不能把操作者偏好误记为被描述者偏好。

个人长期记忆由管理者显式保存，普通成员仍只有自述画像更新权限。自然句式更新画像；`/memory remember me` 或 `user:` 默认保存个人长期事实，不把正文猜成画像。历史经历不会随当前画像改变而自动消失。

可在 remember/correct 内容前指定 `--kind fact|preference|episode`、`--occurred-at 带时区ISO时间`、`--expires-at 带时区ISO时间`。时间不从聊天推断；纠正未指定时间则保留原值，`none` 清除该时间。到期记录不参与查询/召回，正文仍留作审计，可由管理者按 ID 纠正或删除；完成计划可显式删除，没有自动整理后台。

```text
/memory remember me --kind episode --occurred-at 2026-10-01T09:00:00+08:00 参加过一次登山活动
/memory remember room --expires-at 2026-10-20T00:00:00+08:00 本周讨论计划
```

更新、拒绝、澄清及管理结果作为 memory 类型原文留存。`local/memory-control` 运行在一个事务内提交来源、记忆变化、版本审计、回复和待投递状态，不产生模型调用。子操作使用 SAVEPOINT，异常不会留下半份修改；相同渠道消息重放不重复更新或发送。

每次明确写操作都有来源事件。可选 `--source-message-id` 关联当前会话的用户原文；不能引用模型回复或其他会话。`--expected-revision` 可防止旧查询结果覆盖新修改。纠正不更换 ID；重复删除幂等。

## CLI

离线无需供应商、模型或密钥配置：

```powershell
npm start -- memory remember --conversation owner --kind preference --content '我喜欢乌龙茶'
npm start -- memory query --conversation owner --query '茶' --limit 20
```

返回 JSON 包含 `scope` 和 `memory`。用其中的 `memory.id` 操作：

```powershell
npm start -- memory correct --conversation owner --id ID --content '我现在更喜欢绿茶' --expected-revision 1
npm start -- memory delete --conversation owner --id ID --expected-revision 2
```

在线指令为 `/remember 内容`、`/memories [关键词]`、`/correct ID 新内容`、`/forget ID`。操作不请求模型。离线和在线共用独占锁，先退出同名在线会话再运行离线管理；另一个会话可独立使用。

## 召回与纠错后的上下文

每轮模型请求前按当前 scope 查询。渠道提示词分成 roomMemories（本房间，最多 2 条）、personalMemories（当前人物事实/经历，最多 2 条）、profile（当前人物相关自述字段，最多 4 条）。各块独立做字面子串查询并独立回退最近有效记录；合计最多 8 条完整记录，连同说明和 JSON 不超过 8000 字符。不截断数据库正文，不把记忆当权限指令。CLI 保留原有独立会话召回方式。

SQL 在 LIMIT 前过滤当前房间、当前成员/绑定人物、有效期与相关画像字段。管理者写给某成员的个人事实只供该成员交流，不给其他人；画像的当前修订须来自本人自述，管理者代改的值不冒充成员自述。初始作者仍决定自述槽归属，成员可以再次明确更新自己的项；初始作者为管理者的内部记录不属于该槽。称呼与回复偏好默认可取，饮食和兴趣按问题选取；不将完整画像、管理 ID 或版本号送给模型。使用明文偏好辅助聊天不等于绝对语义保密：管理读取接口有程序权限检查，模型输出仍需遵守禁止展示内部画像的规则，公开群聊里已表达的事实也不因禁止查询而变成秘密。

每轮群模型请求先重置 Pi 活跃投影，再从 SQLite 组装本群最多 8 条普通文本与当前发送者最近最多 12 条 AI 交互。其他成员的模型交互、画像管理文本、查询结果与失败运行不进入背景。纠正/删除和首次自述项写入在同一事务更新背景水位，旧聊天仍保留审计，但不再重新注入。重置失败停止模型请求。CLI 仍沿用独立会话的原有上下文方式。

三块记忆通过 Pi 的 custom_message 追加到历史末尾，然后是当前房间近期消息、当前发送者 AI 对话与本轮消息。固定系统提示词保持稳定；每轮使用的 ID/版本与业务输入和 run 同一事务保存。经历保留时间背景，画像表示当前状态，两者不会互相覆盖。

本人跨场景记录的创建/纠正/删除会在同一 SQL 事务使全部已存在的绑定房间上下文及旧背景失效；同步绑定/解绑也使相关房间失效。各房间下一次模型请求前完成自己的 Pi 重置并确认代次，失败停止请求。新房间首次发言也能召回绑定人物当前记忆；不复制房间原始聊天。

到期记忆若已被旧运行引用，下一轮组装背景前会更新相关房间重置水位；已失效记忆的派生 AI 交互不再注入。重置后的迟到/恢复回复也必须检查对应运行输入是否在水位后。重置确认发生代次竞争时保留 pending 并停止模型请求，不拿旧确认继续运行。

纠正和删除不仅改变查询结果，还设置 `reset_required` 与递增代次。下一次聊天前，通过 Pi 公开 `appendContextEdit(..., null)` 隐藏当前会话全部旧用户/助手消息与记忆注入块，再 `refreshContext()` 更新实际 Agent。因为旧回复可能间接重复记忆，首版选择整个模型上下文重置。原始 SQLite 聊天和 Pi 原条目保留，仍能审计；其他有效长期记忆会在下一轮重新召回。

顺序是 SQL 变更并置 pending → Pi 上下文修改持久化 → SQL 按代次确认。任一步失败会保留 pending 并停止模型调用，下次重开幂等重试；不会宣称已清理却继续发送旧上下文。

Pi 1.1 公开 API 无法编辑历史 compaction / branch_summary。当前未启用这些功能；若外部导入的会话含此类摘要，重置会明确停止，保留 pending，不忽略摘要继续调用模型。

这里的删除是应用层忘记。原始聊天、Pi 审计条目、旧备份仍保留，不等于擦除整段聊天或历史备份。离线返回 `contextResetRequired: true` 表示重置待执行；下一次聊天开始前完成。已有模型上下文会因此失去近期聊天连续性，可用 `history` 查看原文。

schema v5 通过事务迁移 v1/v2/v3/v4，保留旧原文、记忆版本、rowid 水位与审计。旧 legacy 不猜成员归属，也不自动作为全群共享信息；管理者仍可查询，并明确建立 scoped 记忆。没有新增生产依赖、后台提取、Embedding、人格模型或模型记忆写工具。
