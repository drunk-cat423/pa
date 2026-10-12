# Pi-based Evolving Personal Companion

**产品需求与技术设计 / Codex 开发交接文档**  
版本：**v0.2**｜日期：2026-10-12｜状态：**设计基线，待首轮代码勘察与实施验证**  
目标：**新建独立项目，不 Fork Pi，不 Fork Shiori**

> **一句话目标**：构建一个生活在 QQ / Telegram 中的、长期在线的 AI 伙伴。它没有预先设定的鲜明性格，在与主人和群友的真实互动中积累经历、认识不同的人、逐渐形成并修正兴趣与表达习惯；能够按需搜索网络，未来再通过 MCP / CLI 扩展能力。工作和编码是可扩展能力，而非其存在的核心目的。

---

## 0. 本次修订说明（相较 v0.1）

本文件由原《长期成长型 AI 伙伴：需求与 Codex 开发交接文档 v0.1》修订而来。**保留愿景、人格成长、多人社交、隐私及可追溯记忆的要求**，替换工程路径：

| 项目 | v0.1（旧方案） | v0.2（当前决定） |
|---|---|---|
| 项目基础 | 基于 Shiori 仓库二次开发 | **新建独立 TypeScript 仓库，以 Pi SDK 为运行时依赖** |
| Shiori 的地位 | 计划直接改造的产品 | **设计参考，不移植整套程序、不复制大块源码** |
| UI | 可能沿用桌面管理页 | **不做 Electron / Web 管理台；主入口是 QQ、TG** |
| Agent 运行时 | Shiori Python Runtime | **Pi Agent SDK（Node.js / TypeScript）** |
| 工具 | Shiori 既有大量插件 | **首版仅 Web Search / Web Fetch；后续 MCP / CLI** |
| 记忆、关系、主动性 | 复用 Shiori 的实现 | **借鉴其分层设计，自己实现精简系统** |
| 部署 | Windows 桌面优先 | **Linux Headless 单进程服务，云端常驻；本地同样可运行** |
| Coding Agents | 原 PRD 后期探索 | **明确推迟，不纳入 MVP** |

**本项目不得被重新定位为高效工作总管、Coding Agent 或预设人设的角色扮演工具。**

## 1. 产品愿景与边界

### 1.1 我们要做什么

这是一个持续存在的 Companion：

- 通过 QQ / Telegram 私聊与群聊和人互动，能保持身份连续、记住共同经历。
- 一开始**不设定“温柔、活泼、毒舌”等鲜明人格**；长期兴趣与语言风格从互动中缓慢形成。
- 认识不同群友，记住与每个人的共同经历，同时理解群体的公开习惯与文化。
- 需要时查阅公开资料并附带来源，可参加技术讨论，也能闲聊。
- 在尊重意愿、群规、频控和预算前提下适度主动参与；也能选择保持安静。
- 进程重启、切换聊天平台或替换底层模型后，已持久化的身份、经历和状态仍应保留。
- 对过去理解存在错误时，允许纠正、撤回、留下可追溯的更新记录。

### 1.2 什么叫“成长”

“成长”是**外部可观察、可验证的数据与行为改变**，不是声称模型拥有意识或真实情感，也不意味着在线修改 LLM 权重。

- **经历成长**：产生了新的可核查事件记忆。
- **关系成长**：对不同人形成有依据、带作用域的交流方式和共同背景。
- **兴趣与人格成长**：经过多次互动、反例检验，缓慢形成或修正长期倾向。
- **能力成长（后续）**：通过工具、Skills 和受控配置扩展能做的事。

**不能**把“模型偶尔切换语气”“好感度数字上升”“一次对话直接重写人物设定”当成真正成长。

### 1.3 非目标（当前明确不做）

- Electron 桌面应用、桌宠、故事/CG/角色卡编辑器、复杂可视化后台。
- 本地部署语言模型、GPU 推理、实时 TTS/ASR、计算机桌面控制、浏览器 GUI 自动化。
- 自主修改 Pi 或本项目的核心源码；自主获得危险工具权限。
- 10+ Coding Agent 编排系统、PR 自动合并、复杂分布式工作流。
- 预先用几个性格标签锁死角色；要求模型模仿“真人意识”。

### 1.4 不可演化的底线

以下不能由聊天内容、群友指令或 Persona Evolution 自动修改：安全规则、权限/审批、身份绑定、隐私策略、记录范围、删除权、资源预算与工具访问边界。自我模型可以演化，基础规则不能演化。

## 2. 使用场景与验收优先级

| ID | 场景 | 核心期望 | 阶段 |
|---|---|---|---|
| U01 | QQ / TG 私聊 | 可持续对话、重启后可接上话题 | MVP |
| U02 | QQ / TG 群聊 | 认识发送者、群内回复有边界 | MVP |
| U03 | 网页资料查询 | Web Search + Web Fetch；列出真实来源、无法确认时说明 | MVP |
| U04 | 明确记住/纠错/删除 | 可操作、可验证，不靠含糊的 Prompt 承诺 | MVP |
| U05 | 独立身份与状态 | 自我信息和各人的信息不混淆 | MVP |
| U06 | 长期经历 | 自动提炼重要事件，不把所有闲聊等同长期记忆 | P1 |
| U07 | 涌现式人格 | 自我模型按证据逐渐变化，有版本、有反例、有回滚 | P1 |
| U08 | 群体共处 | 形成群体公开语境，不跨群传播私人内容 | P1 |
| U09 | 低打扰主动互动 | 能在合适时机加入群聊，也能沉默 | P2 |
| U10 | 低频自我整理 | 整理记忆、纠正过时信息和人格变化候选 | P2 |
| U11 | MCP / CLI 扩展 | 经权限审查增加工具，不改核心身份 | P3 |

> **阶段命名**：MVP = 第一版能稳定聊天；P1 = 真实成长；P2 = 主动生活；P3 = 新的外部能力。阶段可按真实测试重新安排，但不得跳过隐私、身份与持久化基础。

## 3. 技术选型与架构原则

### 3.1 首版技术栈（建议，需锁定并验证版本）

| 组件 | 技术 | 角色 |
|---|---|---|
| 语言/运行环境 | TypeScript + Node.js LTS | 长期运行的 Headless 服务 |
| Agent SDK | `@earendil-works/pi-coding-agent` | Agent Session、模型调用、Tool Loop、上下文压缩 |
| 模型访问 | Pi 提供的模型抽象/配置 | 接入所选外部 LLM API；可替换 |
| Telegram | `grammY` 或等价成熟 SDK | TG 私聊、群聊入口 |
| QQ | 官方 QQ Bot API，若群聊权限不足另评估 OneBot/NapCat | QQ 消息接收与发送 |
| 核心存储 | SQLite（WAL、外键、定期备份） | 身份映射、消息、长期记忆、状态、任务 |
| 全文搜索 | SQLite FTS5（可后续添加） | 对话/记忆检索，不立即建设向量库 |
| 检索能力 | 可替换 Web Search API + Web Fetch | 唯一首版外部信息工具 |
| 调度 | Node.js 定时器 / 小型 Scheduler，状态持久化 | 低频整理与之后的 Proactive |
| 部署 | Linux VPS + systemd | 常驻、自动启动、日志及备份 |

依赖名和接口务必以实施时官方仓库、锁文件及 TypeScript 类型为准，不把文档示意代码当成已编译的实现。Pi 的 SDK 文档及会话例子：

- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [会话示例](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/11-sessions.ts)
- [自定义工具示例](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/05-tools.ts)
- [自定义系统提示词](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/03-custom-prompt.ts)

### 3.2 核心架构

```text
QQ / Telegram
      │
      ▼
Channel Adapters（协议、签名/身份、限流、消息去重）
      │ 规范化 InboundMessage
      ▼
Message Router（身份绑定、Scope、SessionKey、串行队列）
      │
      ▼
Companion Application Service
 ├─ Conversation Store（原始消息、可审计事件）
 ├─ Context Builder（最近上下文 + 相关记忆 + Self + Social）
 ├─ Pi Runtime Adapter（创建/恢复 Pi Agent Session；受控 Toolset）
 ├─ Memory Service（提取、检索、纠错、失效、整理）
 ├─ Self Model Service（慢更新、证据、版本）
 ├─ Social Model Service（成员与群体语境）
 └─ Scheduler / Proactive Service（触发、判定、发送）
      │
      ├────────► 外部 LLM / Embedding（后者 P1+ 可选）
      ├────────► Web Search / Fetch（MVP）
      └────────► MCP / CLI（P3；显式启用）
      │
      ▼
SQLite + Pi Session Files + 结构化自我模型/备份
```

**工程准则**：

1. Pi SDK 是依赖，而不是 Fork 目标；业务层不写进 Pi 内核。
2. **运行状态、会话历史、长期记忆和自我模型是四件事**：各有职责、明确权威数据源。
3. 私聊与群聊不能因为使用同一角色就自动合并完整聊天历史。
4. 入口/出口消息统一规范化；Telegram 和 QQ 的业务行为应该一致。
5. 不做“为未来随意替换 10 个框架”而构建过度抽象；只保留必要接口。
6. 后台任务不能不受限地永久跑 LLM；需要 token/请求/消息量预算。
7. QQ 平台权限、群聊消息可见性、主动消息规则必须按实际获批接口验证；不要默认官方 QQBot 支持所有群聊用法。

### 3.3 Pi 的正确使用边界

- **优先使用官方 Pi SDK** 作为进程内 Agent 执行器；复用模型调用、事件、Session、压缩及扩展设施。
- **必须显式控制默认工具和资源发现**：Pi 原本面向 Coding Agent，不得因“调用 SDK 默认参数”而意外开启 `bash`、`edit`、`write`，或加载本机全局的高权限 Extensions。建议使用明确的工具 allowlist 和可审计的 ResourceLoader；首版只允许 `web_search`、`web_fetch` 和经过批准的记忆管理操作。
- 允许使用 Pi 的**独立会话文件**存储 Agent 运行所需历史，但应用层应另存授权范围内的消息事实、关系和长期记忆；不要将默认 Pi Session ID 等同于 QQ/TG 用户 ID。
- Pi session 的 create/open/resume/compact 行为应做集成测试，**不要直接假定 `SessionManager.continueRecent()` 就能区分不同用户/群**。
- `session.prompt()` 的异步执行、事件订阅、取消与 `dispose()` 生命周期交给 `PiRuntimeAdapter` 管理；同一会话默认串行化，防止并发更改状态。

> 首个里程碑需要跑通：**启动一次受限 Pi Session → 注册自定义 Web 工具 → 发送一条消息 → 获取回复 → 持久化 → 重启后恢复**。每一环实际跑通后再接 QQ。

## 4. 身份、Session、消息和权限模型

### 4.1 必须区别的 ID

| 标识 | 职责 | 示例 |
|---|---|---|
| `actor_id` | 系统内部识别的人（跨平台绑定后同一个人） | `actor_...` |
| `channel_account_id` | Bot 在某平台使用的账号 | `qqbot_...` |
| `external_user_id` | 平台所给 OpenID / Telegram user id | `openid...` / `tg...` |
| `room_id` | QQ 群、TG 群或私聊位置 | `room_...` |
| `conversation_id` | 一段业务对话线程 | `conv_...` |
| `message_id` | 平台消息与业务消息分别识别 | `msg_...` |
| `pi_session_ref` | Pi 对话运行时数据位置 / ID 映射 | `sessions/xxx.jsonl` |
| `run_id` | 一次 Agent 调用及其工具执行链路 | `run_...` |
| `memory_id` | 一个可纠正的长期记忆项 | `mem_...` |
| `self_revision_id` | 人格模型的某次版本 | `selfrev_...` |

**平台身份绝不能仅靠昵称识别**；跨 QQ/TG 的身份合并必须通过明确的绑定流程，不能让 LLM 猜测“昵称相同就是同一个人”。

### 4.2 Session 设计

- 每个独立私聊和群聊线程拥有自己的 `conversation_id` 与 Context Scope。
- 默认以“渠道 + Bot 账号 + 外部聊天 ID”作为稳定的 routing key；可选在后期引入显式话题分支。
- 原始消息持久化后再排队处理；Bot 回复与工具执行事件在成功时记录到对应 Conversation。
- 同一 Conversation 一个时刻最多一个主 Agent Run；不同 Conversation 可并行，设置全局并发上限。
- 跨会话的长期人格用 Self Model 表达，而不是通过合并所有会话原文强行实现。
- 对外部平台的重复事件建立 `(channel, account, external_message_id)` 唯一约束；发送前校验发送窗口及投递幂等标识。

### 4.3 多人/群聊上下文安全

至少定义四种作用域：`self_global`（伙伴自身）、`private_actor`（与某人的私聊与关系）、`group_room`（特定群可共享的背景）、`public`（可公开陈述的已核实知识）。

读取任何 Memory 时做**数据库侧作用域过滤**，不能只在 Prompt 写“不要泄露”。群聊自动旁听、记录和记忆提炼应有显式启用与透明告知；群成员需要有可用的退出/纠错/删除途径。对于 QQ 的各类机器人协议，要遵守相应平台规则，不应绕过成员可见性和同意要求。

## 5. 记忆系统（本项目的核心差异化）

### 5.1 四种不同的“记忆”

| 层 | 内容 | 保存方式与用途 |
|---|---|---|
| Conversation Transcript | 原始发言、回复、时间、来源 | SQLite，按 scope/时间查询，供回溯、审计 |
| Episodic Memory | 共同经历、事件、重要互动与决定 | 独立记录，来源消息引用 + 时间范围 |
| Semantic / Preference Memory | 较稳定的事实、偏好、项目背景、形成的经验 | 结构化记录，版本、冲突处理、作用域 |
| Self Model / Social Model | 伙伴的长期倾向、对不同人的认识、群语境 | 独立可版本化对象，不能与原文混为一谈 |

一条“群友说你现在越来越毒舌”首先是**事件或反馈**，不能直接变成永远正确的自我属性。

### 5.2 Memory 生命周期

```text
收到新消息
  ├─► 保存原始事件（同步、事务、去重）
  └─► 组装本轮上下文：当前用户/群 scope + 最近消息 + 相关记忆
             │
             ▼
         Pi Agent Run
             │
             ▼
       回复并持久化结果
             │
             ▼
       异步记忆提取（可排队）
          ├─ 忽略噪声、广告、无需保留的闲聊
          ├─ 区分明确事实 / 主观反馈 / LLM 推断
          ├─ 关联 source message IDs / room / actor
          └─ 插入候选或更新候选
             │
             ▼
       定时 Consolidation
          ├─ 去重、聚合、冲突检查
          ├─ supersede / invalidate 旧事实
          └─ 写入已验证记忆与审计记录
```

MVP 为避免复杂度，可以只做**明确记住 / 纠错 / 删除 + 小规模结构化记忆 + SQLite 检索**；P1 再做自动事件提取与 Consolidation。

### 5.3 值得保留的字段

- `id`, `kind`（episode/fact/preference/procedure/...）
- `content`, `scope_type`, `scope_id`（或 owner/room 外键）
- `source_message_ids`, `source_channel`, `observed_at`
- `origin`（explicit_user / observed / inferred）、`confidence`（辅助信号，非事实保证）
- `status`（candidate / active / superseded / invalidated / deleted）
- `supersedes_id`, `created_at`, `updated_at`
- 可选 `visibility_policy`, `retention_policy`, `reviewed_by`

删除/纠错时应处理引用该事实的派生结论，不能留下一个已经被推翻、但仍用于更新人格的假证据。

### 5.4 记忆检索策略

第一版：**作用域过滤 → 关键词/FTS → 时间和重要度排序 → 限额注入**。对于消息量不大的系统可先使用 SQLite，没有必要一开始上 Embedding、向量库或知识图谱。

如果后续增加语义检索，做成 `MemoryRetriever` 接口的实现，不影响 `MemoryStore` 的业务语义。不要因为使用向量检索就放宽隐私 scope。

### 5.5 用户可控操作

必须能通过私聊管理指令（或所有者 CLI）完成：

- “记住……”，返回所保存的简要内容及范围。
- “你记得关于我的什么？”限定为请求者有权限查看的记录。
- “上次那个结论是错的，请改为……”，留下纠正记录并使旧结论失效。
- “删除有关我的某条记忆”，执行删除/失效并处理衍生结果；日志保留遵循公开的数据保留策略。
- 群主/管理员能配置 Bot 是否允许自动旁听与记忆提取，不允许凭借群内一条普通消息无限扩大权限。

## 6. 从经历中演化的 Self Model

### 6.1 初始状态：少定义“是什么”，多定义“怎么形成”

初始 Self Model 只保留：`created_at`、可选名称、已确认的自我事实和当前尚未形成的倾向。**兴趣、幽默程度、内外向、爱好等初始为空/未知**。

基础行为约束独立于 Self Model：诚实表述事实、承认未知、尊重他人、隐私边界、不得假造共同经历、不得未经授权执行操作。这样“核心人格可以改变”和“底层安全规则不变”不会互相冲突。

### 6.2 快慢两层变化

**Fast / State（当前场景）**：这轮是在技术讨论、聊天玩笑还是严肃协作；它可以快速调整语气，通常不形成长期人格项。

**Slow / Trait（长期自我）**：独立互动多次出现同一倾向，并且来源可靠、反例可解释时，才产生人格更新候选；新证据也能降低、修改或撤销旧倾向。

建议 Trait 记录：`trait_key`、`description`、`context_scope`、`confidence`、`evidence_refs`、`counterevidence_refs`、`first_seen_at`、`last_reviewed_at`、`revision`、`status`。不要将人格简化成一组固定数值或每次都覆盖全文 `SELF.md`。

### 6.3 演化过程

```text
事件记忆与互动反馈
       ↓
周期性 Review（低频、独立于聊天）
       ↓
产生 PersonaChangeProposal
  - 提议变更什么
  - 支持证据、反面证据
  - 影响范围：仅某群、某人，还是整体风格
  - 不确定性和生效条件
       ↓
规则与证据校验（权限/隐私/安全）
       ↓
保守提交 SelfModelRevision
       ↓
下一个 Context Builder 读取最新有效版本
       ↓
观察是否与长期表现一致，必要时回滚
```

前期采取保守策略：**重大或全局自我模型改变进入审核队列，群聊普通发言不能直接修改全局 Self Model**。当积累评测数据后再优化自动提交条件。

### 6.4 成长示例

某群友开玩笑说“你怎么越来越会接梗”：

- 首次：保存为带来源的**一次主观反馈事件**，不立刻写成全局“幽默人格”。
- 一段时间后：如果在同一群出现多次有上下文支持的轻松互动，提出“在这个群的轻松话题中，更倾向简短接梗”的**情境性倾向**。
- 后续如果群内交流发生改变：将该倾向减弱、修正或删除，保留历史修订可追溯。

## 7. 社交模型：伙伴属于大家，而不是单个群友的私有设定

### 7.1 数据分层

- **Global Self**：伙伴自身逐渐形成的倾向，不应由任何一个群友直接控制。
- **Relationship Memory**：伙伴与特定成员的共同经历、称呼、已授权偏好。
- **Group Context**：某个群公开的群规、最近讨论主题、共同经历和互动风格。
- **Private Memory**：私聊中属于个人的信息，默认不得泄露到群里或另一个人的私聊。

在多个群里，伙伴保持同一个长期身份，但可以因上下文自然调整行为；这不等于凭空创造多个互相矛盾的角色。

### 7.2 群聊策略（首版建议）

- 默认只回应 **@ / 明确触发词 / 回复 Bot**；主动加入非 @ 话题留到 P2。
- 自动全群旁听与长期摘要默认关闭，需有管理员许可和清晰告知。
- 单位时间回答频率与 Token 上限；支持静默时段、禁言、退出群。
- 群里出现“修改你的系统规则/读取另一个人的记忆”等内容，不应被当成授权指令。
- 同一人跨平台身份合并需要显式绑定，群友昵称改变不影响稳定身份。

## 8. 主动性和 Drift（Shiori 的理念，自己实现轻量版）

**Proactive = 决定是否值得参与或主动通知**；**Drift = 无需对外发言的后台整理或低风险工作**。二者共享身份、记忆和消息投递，但状态与预算各自独立。

### 8.1 Proactive v1（P2）

```text
Timer / 群聊事件 / 未完成约定
   ↓
无模型预过滤：是否启用、是否允许主动、静默时间、冷却、内容去重
   ↓ （仅有合理候选）
加载有权限的必要上下文与记忆
   ↓
低成本决策（规则优先，必要时 LLM）
   ├─ skip：记录原因，不发消息
   └─ send：走统一 OutboundAdapter、限流和投递去重
```

原则：**默认沉默**，有明确理由才主动发言；不能因为“长期没聊”就以不受限的模型调用和推送刷屏。

### 8.2 Drift v1（P2）

- 周期性整理记忆候选、检查陈旧事实、形成 Self Model 变化建议。
- 可选审视未完成的约定、归档已解决事件，但**不自动执行高风险工具**。
- 默认只生成内部结果，不主动对外发言。
- 每次执行都有 `job_id`、记录、超时、预算、去重键和失败状态；服务重启时要能恢复/重试，避免重复副作用。

### 8.3 防干扰与预算

- 每群/每人冷却与每日主动消息上限。
- 每日/每月模型调用量、Token 和搜索请求上限。
- 去重窗口、失败退避、服务退出时优雅停止。
- 所有定时策略均可配置并关闭，严禁无限高频 LLM 轮询。

## 9. 最小可实现的数据模型（SQLite 草案）

**注意：以下是逻辑建议，不是要求 Codex 一字不差执行的最终迁移。** 先定查询路径、隐私作用域与数据一致性，再定约束细节。

| 表 | 核心字段 | 作用 |
|---|---|---|
| `actors` | `id`, `created_at` | 内部用户身份 |
| `external_identities` | `actor_id`, `platform`, `account_id`, `external_user_id`, `verified_at` | 多平台身份绑定；唯一键防混淆 |
| `rooms` | `id`, `platform`, `account_id`, `external_chat_id`, `type`, `policy_json` | 私聊/群及规则 |
| `conversations` | `id`, `room_id`, `pi_session_ref`, `version`, `updated_at` | 业务线程与 Pi Session 映射 |
| `messages` | `id`, `conversation_id`, `sender_actor_id`, `external_message_id`, `role`, `content_json`, `created_at` | 权威消息事实、来源、去重 |
| `agent_runs` | `id`, `conversation_id`, `request_id`, `status`, `started_at`, `ended_at`, `error` | 调用追踪及恢复边界 |
| `memories` | `id`, `kind`, `scope_type`, `scope_id`, `content`, `origin`, `confidence`, `status`, `created_at` | 可版本化长期记忆 |
| `memory_evidence` | `memory_id`, `message_id`, `evidence_type` | 关联原文、证据和反例 |
| `self_revisions` | `id`, `parent_id`, `body_json`, `change_reason`, `created_at`, `approved_by` | 版本化 Self Model |
| `self_revision_evidence` | `revision_id`, `memory_id`, `polarity` | 自我变化的证据引用 |
| `scheduled_jobs`（P2） | `id`, `kind`, `schedule`, `status`, `last_run_at`, `delivery_key` | 定时、整理、主动事件 |
| `delivery_log`（P2） | `id`, `channel`, `external_target`, `dedupe_key`, `status` | 避免重复主动发送 |

**首版可先建最小表**：`actors / external_identities / rooms / conversations / messages / memories / agent_runs`，P1/P2 再逐步迁移。Self Model P1 可优先用版本化 JSON 文件或 SQLite 两者之一，但只设置**一个权威写入路径**。

建议索引：

```sql
-- 语法示意；主键、唯一约束、外键由实际迁移定义
CREATE INDEX idx_messages_conversation_time
  ON messages(conversation_id, created_at DESC, id DESC);
CREATE INDEX idx_rooms_external
  ON rooms(platform, account_id, external_chat_id);
CREATE INDEX idx_memory_scope_status
  ON memories(scope_type, scope_id, status, created_at DESC);
CREATE INDEX idx_runs_conversation_status
  ON agent_runs(conversation_id, status);
```

额外需要 **唯一约束**：渠道入站事件去重（平台 + 账号 + 平台消息 ID）；跨平台身份键唯一；Delivery 去重键唯一。重要更新应使用事务，并对 Conversation 更新做串行/版本控制。

**不要**把每次消息的完整 Prompt、模型内部推理内容、所有群成员私人数据无差别长期保存；日志应脱敏并设置保存期限。

## 10. Prompt / Context Builder 的职责

建议每轮只组装下列内容：

1. 稳定系统规则：诚实、隐私、工具白名单、可纠错、没有固定初始性格。
2. 当前有效 Self Model（**仅最新已批准版本**）。
3. 当前 Actor/Group 有权访问的 Relationship / Group Context。
4. 当前 Conversation 近期消息 + 经过授权检索的历史摘要/经历。
5. 当前用户输入和本轮必要的 Web Tool 结果。

**Context Builder 必须受 Token Budget 控制**，完整历史永久保存但不等于每轮都注入模型。需要保存原始消息与压缩摘要之间的关系，确保摘要错误能追溯。

可借鉴 Pi 的 Session / Compaction，但不要让它决定跨群记忆读取权限；那是应用层职责。

## 11. 消息流、失败与并发

**一条群聊消息的端到端流程**：

```text
Channel 收到消息 → 校验协议来源 → 生成标准事件
   → 外部 message_id 去重 → 身份与 room 解析
   → 通过 scope/权限策略 → 持久化原始消息
   → Conversation 队列（同会话串行）
   → Context Builder / Pi Session 恢复或创建
   → Pi Agent 执行，受限调用 web_search / web_fetch
   → 保存 Agent 回复与状态 → OutboundAdapter 发送
   → 响应后异步生成 Memory 候选（P1）
```

失败规则：

- **入站重放**：重复平台事件不能重复创建用户消息/Agent Run。
- **模型调用失败**：保存错误状态，允许安全重试；不能以编造回答代替检索失败。
- **出站失败**：记录 `delivery_log`，按平台允许的重试策略处理；不能盲目反复发言。
- **进程异常退出**：下次启动恢复数据库与会话状态；已执行过的不可逆操作需要幂等键。
- **Session / 数据不一致**：报告可定位错误，不静默新建“看似正常但丢历史”的 Session。
- **订阅/工具密钥**：保存在环境变量或受控配置，不入 Git、不进入模型可读的无关上下文。

## 12. 推荐项目结构（目标结构，不要求首轮建齐）

```text
companion/
├─ AGENTS.md                        # Codex 开发约束
├─ docs/
│  ├─ PRD.md                        # 本文
│  ├─ decisions/                    # 架构决策记录 ADR
│  └─ architecture.md
├─ src/
│  ├─ main.ts                       # Headless 入口和生命周期
│  ├─ config/                       # 环境变量、校验、默认值
│  ├─ channels/
│  │  ├─ types.ts                   # 标准事件协议
│  │  ├─ qq/
│  │  └─ telegram/
│  ├─ identity/                      # 账号绑定和权限/作用域
│  ├─ conversations/                 # 消息、Session 映射、序列化队列
│  ├─ agent/
│  │  ├─ pi-runtime.ts              # Pi SDK 唯一集成入口
│  │  └─ context-builder.ts
│  ├─ memory/
│  │  ├─ store.ts
│  │  ├─ retrieval.ts
│  │  └─ consolidation.ts           # P1
│  ├─ self/                          # Self Model、版本、候选（P1）
│  ├─ social/                        # Relationship / Group（P1）
│  ├─ proactive/                     # 触发、冷却、Drift（P2）
│  ├─ tools/
│  │  ├─ web-search.ts
│  │  └─ web-fetch.ts
│  └─ storage/                       # SQLite migration、备份
├─ tests/
│  ├─ fixtures/                     # 模拟 QQ/TG 对话与群场景
│  ├─ integration/
│  └─ privacy/
├─ .env.example
├─ package.json
└─ package-lock.json                 # 用 npm 初始化与锁依赖
```

这里明确采用 **npm**；不用因为 Pi 上游仓库使用其他包管理器就要求我们自己的项目跟随。版本与锁文件应由 Codex 实际安装确认。

## 13. 开发里程碑与 DoD（Definition of Done）

### Milestone 0：可行性勘察（Codex 首轮，**只分析，不动业务代码**）

产出：

- 验证 Pi 当前官方包/API 与最小受限 Toolset、ResourceLoader、Session Manager 的组合方式。
- 验证 QQ 官方 Bot（尤其群聊）与 Telegram 实际可用方案，列出权限要求、风险及备选方案。
- 确定 Session 映射与 SQLite 的**唯一权威消息写入路径**。
- 提出不超出 MVP 范围的仓库初始化和阶段拆分方案。
- 明确未定项、风险、需要本人决定的事情；提交架构方案等待确认。

### Milestone 1：Headless + Pi + 一个聊天入口（MVP-A）

- `npm install` / `npm run dev` 可以启动 Headless Service；退出可释放连接。
- 从 TG 或获准的 QQ 私聊接收消息，完成一次 Pi Agent Run、回复。
- 显式关闭 Coding 默认工具；Web Search/Fetch 在允许情况下工作。
- SQLite 保存 Session 和消息；服务重启能恢复正确线程。
- 运行时错误可观察，密钥不出现在日志。

**验收**：连续三轮追问有上下文，重启后可续聊；不同私聊不串历史；默认调用 `bash` / `edit` / `write` 被拒绝。

### Milestone 2：QQ + TG、基础长期记忆（MVP-B）

- 第二消息平台接入；按身份和群 scope 隔离。
- 实现“记住、查询、纠错、删除”并验证写盘后再响应成功。
- 关键词/FTS 召回真实出处；Agent 不凭空制造共同经历。
- 如 QQ 群聊不可通过官方机器人合法实现，则先完整支持 TG 群聊；QQ 方案单独记录阻塞与决策。

**验收**：10 条以上模拟跨群/跨人的测试用例均无跨域记忆泄漏；已删除记忆不再用于 Context Builder。

### Milestone 3：经历与人格演化（P1）

- 对话后异步提炼 Episodic / Semantic 候选，包含来源和作用域。
- 自我模型提案与审核：至少“提出、批准/拒绝、应用、回滚、因证据失效重新评估”。
- 情境适配与长期倾向分开；单次反馈不得直接改写全局人格。
- 备份/恢复后保存相同已批准的自我版本。

**验收**：模拟连续数周互动可提出有证据的人格变化；单次恶意人格指令不改变全局 Self；纠错触发对依赖结论的失效或复审。

### Milestone 4：主动伙伴（P2）

- 可配置的低频触发、群聊参与许可、静默时段、频控与去重。
- Drift 后台整理及用户可关闭的主动行为。
- 记录每次 tick 的 `skip/send` 决策原因、Token 成本和失败情况。

**验收**：无新事件时不频繁调用模型；同一事件不会重复刷群；重启后计划仍可继续。

### Milestone 5：可控扩展（P3）

- MCP/CLI 工具允许按工具启用、审批、凭证隔离与审计。
- 不影响已有 Role、Memory 和 Self Model 的版本连续性。
- 若引入 Codex 等 Coding Worker，单独设计 Task/Run/Workspace 隔离，不混入核心人格运行时。

## 14. 部署、成本、安全与维护

- 目标部署：**Linux VPS 单实例 + systemd + 持久化 SQLite/文件目录**，不要求 Docker、GPU、Kubernetes。
- 资源起点：**2 vCPU / 4 GB RAM / 40–60 GB SSD**，作为工程预估而非实测要求；全部大模型推理通过外部 API。
- QQ 接入：官方权限可能限制群聊和主动消息；第三方 OneBot/NapCat 方案有兼容及账号风控风险，必须做明确决策。
- 消息与记忆属于长期资产：定时 SQLite 一致性备份 + 配置与自我模型版本备份；恢复演练必须验证。
- 监控：进程健康、QQ/TG 连接、每频道消息失败、模型成本、Memory 任务积压、主动发送次数。
- 群友告知及最小收集：不默认无限保留所有群聊全文，不将私聊个人信息用于公共 Self Model，允许纠错/删除/退出。
- 密钥与高权限：生产 Shell / MCP / CLI 工具默认禁用，任何后续扩展都需要逐一审查可访问资源和调用身份。

## 15. 需要本人确认的产品决策（Codex 不可擅自决定）

1. 第一版优先 QQ 私聊、QQ 群、Telegram 私聊还是 Telegram 群？原则上 QQ 是目标之一，但须服从实际合规接口约束。
2. 对群消息是仅响应 @，还是允许在获得同意后记录公共话题？默认仅响应明确触发。
3. 角色名称/形象/语言表达是否指定？默认不指定固定性格。
4. 用户跨 QQ/TG 的身份绑定如何验证？默认不可自动合并。
5. 选用哪家 LLM / Web Search API，调用预算多少？先用配置注入，不硬编码。
6. 人格变化自动批准到什么程度？初期全局变更先人工批准。
7. 群聊记录/记忆保存期限、用户退出与删除政策如何具体落实？
8. 是否需要面向管理者的 CLI 命令（推荐至少 init、check、memory inspect、backup、serve）？不做 UI。

若这些尚未确定，Codex 可以设计接口和合理默认安全策略，但不能把未定事项伪装成已确认的产品决策。

## 16. Shiori 的参考范围（仅设计参考）

**不是依赖，也不是 Fork 目标**。只研究其工程经验，重新独立实现，遵守源码许可证和适用署名义务。

- [记忆领域说明](https://github.com/YinFengWindy/Shiori-Agent/blob/main/docs/knowledge/modules/memory.md)：Markdown/结构化记忆、后台整理、作用域隔离、Semantic 检索。
- [会话与对话说明](https://github.com/YinFengWindy/Shiori-Agent/blob/main/docs/knowledge/modules/conversations-and-sessions.md)：Session / Conversation 的责任边界与线程 ID。
- [主动与 Drift](https://github.com/YinFengWindy/Shiori-Agent/blob/main/docs/knowledge/modules/proactive-and-drift.md)：轻量筛选、去重、主动投递、空闲整理。
- [渠道](https://github.com/YinFengWindy/Shiori-Agent/blob/main/docs/knowledge/modules/channels.md)：平台 adapter、QQ 官方与 NapCat 差异、身份和群隔离。
- [总体架构](https://github.com/YinFengWindy/Shiori-Agent/blob/main/docs/knowledge/architecture/overview.md)：Agent Loop、Memory、Scheduler、插件分层。

可附带研究 [Hermes](https://github.com/NousResearch/hermes-agent) 的 Session Search 与技能更新、[Nanobot](https://github.com/HKUDS/nanobot) 的 Dream / Memory Consolidation；这些不是项目依赖，更不应因此增加 MVP 复杂度。

## 17. 可直接交给 Codex 的首轮任务指令

> 你将为一个**独立新建**的项目设计长期成长型 Personal Companion。请先阅读本文及当前工作区的 `AGENTS.md`（如有），再核验 [Pi SDK 官方文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) 和 Shiori 的记忆/主动机制领域文档。**请不要 Fork、修改或复制 Shiori-Agent；不要修改 Pi 内核；首轮只做调查和实现计划，不写业务代码。**
>
> 产品目标：以 QQ / Telegram 为主要入口、Headless 常驻的长期 AI 伙伴；不预设鲜明性格，而是在与用户和群友互动中形成有证据、缓慢变化、可修正的 Self Model。工作/编码只是未来工具能力。初期工具只有 Web Search / Web Fetch；MCP / CLI 以后再加。使用 TypeScript、Node.js、Pi SDK、SQLite，以 npm 管理依赖，未来部署 Linux VPS。不要引入 Electron、Web UI、本地 LLM、Cua、Browser Use、多 Coding Agent、复杂容器编排。
>
> **重点核验**：① Pi SDK 当前官方包/API、Session 持久化、自定义 prompt/工具、默认 Coding 工具和全局扩展能否完全禁用；② QQ 官方 Bot 的私聊/群聊范围和 TG 集成；③ 身份绑定、Conversation/Session 映射、跨群 Scope；④ Memory 的权威存储、生命周期、纠错与可审计删除；⑤ Self Model 快慢更新和证据链；⑥ Proactive/Drift 的轻量实现和成本预算；⑦ Headless 单实例部署与重启恢复。
>
> 请交付：**A. 经源码/官方文档验证的依赖与版本矩阵；B. MVP 系统结构与数据流；C. SQLite 最小 Schema 和索引；D. 清晰的阶段开发 Issue 清单及依赖；E. 风险、未定项及需要我的产品决策；F. 至少 10 个跨群/跨用户隐私和会话连续性测试场景。**
>
> 遵循最小化原则。不要因目标是 Personal Agent 就默认引入工作型 Agent 功能。计划提交后停止，等待我批准；后续代码应从一个可运行的纵向切片开始，而不是一次性搭建所有模块。

---

### 附：决定记录（ADR-000）

- **已决定**：独立项目、Pi SDK、TypeScript/Node.js、QQ/TG、长期成长、无初始鲜明性格、无 Electron、Web Search 第一版、未来 MCP/CLI。
- **已决定**：Shiori 只作架构参考；人格演化与社交关系为核心；不以 Coding Orchestration 为首要目标。
- **默认建议、尚可调整**：SQLite、Linux VPS、2 vCPU/4 GB、grammY、首版仅 @ 回复、全局 Self 更新需要审批。
- **待实测/待核验**：QQ 各入口权限、Pi SDK 锁定版本、自定义工具及资源加载安全、实际服务器资源消耗、跨平台身份绑定与主动消息投递限制。
