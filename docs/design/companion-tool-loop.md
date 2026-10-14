# PA 当前架构与系统流程

依据当前 QQ 正式服务实现绘制；图中的任务并发、投递和记忆流程均对应实际代码。提供 [SVG 矢量图](companion-tool-loop.svg)、[PNG 预览](companion-tool-loop.png) 和 [Mermaid 源文件](companion-tool-loop.mmd)。

自然语言统一交给 Pi Agent Loop；程序只识别显式管理命令，不匹配“记住”“续问”“搜索”等语义前缀。用户消息先保存并去重，工具写入只能使用当前运行绑定的真人来源。

```mermaid
---
config:
  theme: base
  markdownAutoWrap: false
  themeVariables:
    fontFamily: Microsoft YaHei, Noto Sans CJK SC, sans-serif
    fontSize: 16px
    primaryTextColor: '#17324d'
    lineColor: '#60778e'
  flowchart:
    htmlLabels: false
    curve: linear
    nodeSpacing: 35
    rankSpacing: 45
    wrappingWidth: 360
    useMaxWidth: false
---
flowchart TD
  subgraph INPUT["QQ 接入与任务调度"]
    A["QQ Gateway READY 后恢复任务<br/>接收群聊 / 私聊消息"] --> B["适配器规范化事件<br/>白名单、发送者 ID、事件去重<br/>SQLite 保存原文"]
    B --> C{"群内真实 @<br/>或允许的私聊？"}
    C -->|否| OBS["仅保存观察，不调用聊天模型"]
    C -->|是| TASK["SQLite 持久任务队列<br/>默认并发 2；超额等待"]
    TASK --> CMD{"显式命令？"}
    CMD -->|"/memory 等"| ADMIN["本地管理鉴权与执行<br/>保存控制回复，不调用模型"]
    CMD -->|"/result"| RESULT["领取本人在当前房间的模型结果<br/>保存控制回复，不调用模型"]
    CMD -->|自然语言| CTX["模型任务使用独立 Pi 会话<br/>组装身份、画像、历史、引用<br/>Topic 召回仅在 Embedding 配置后可用"]
    CTX --> CAP{"完整上下文含预留输出<br/>是否能装入模型窗口？"}
    CAP -->|不能| WAIT["等待后台整理并重新组装<br/>仍超限或整理失败则结束本次请求"]
    WAIT -->|整理成功后| CTX
  end

  subgraph AGENT["Pi 工具循环：最多 6 次模型请求 / 8 次工具执行"]
    LLM["调用 LLM<br/>默认轻松简短；专业模式严谨分析<br/>最后一次请求关闭工具，预留收尾"] --> CHOICE{"模型是否请求工具？"}
    CHOICE -->|否| SAVE["核对 Pi 运行标记与 entry ID<br/>SQLite 保存最终答案、投递与任务结果<br/>释放计算槽，允许下一问开始"]
    CHOICE -->|是| TOOL["程序核验工具、参数、身份与次数<br/>update_profile → 原文保存为未归档画像<br/>read_history → 本房间 FTS5 / BM25，最多 10 条<br/>web_search / web_fetch → 公开资料与内部来源<br/>answer_in_depth → 专业提示与一次短进度"]
    TOOL --> TOOLRESULT["工具结果及错误交回 Pi<br/>同一任务继承证据、身份和剩余次数<br/>专业模式禁重复切换及画像写入"]
    TOOLRESULT --> LLM
    TOOL -. "短进度也走发送队列" .-> PROGRESS["保存 run_progress<br/>不作为人物事实证据"]
  end

  subgraph DELIVERY["QQ 投递：计算并行，同房间完整回答依次发送"]
    SAVE --> OUT["同房间发送队列<br/>转纯文本，约 500 字符分段<br/>搜索回答不附来源网址 / 参考链接"]
    ADMIN --> OUT
    RESULT --> OUT
    PROGRESS --> QUEUE["等待本房间正在发送的回答完成"]
    QUEUE --> MODE
    OUT --> MODE{"临发送判断<br/>仍在 5 分钟被动窗口且槽位足够？"}
    MODE -->|是| PASS["被动回复：带原消息 ID<br/>进度与正文共用最多 5 个槽位"]
    MODE -->|否| ACTIVE["主动发送：不带原消息 ID / msg_seq<br/>最终答案附昵称、问题摘要与任务编号"]
    PASS --> INTENT["发送前持久化模式、槽位与发送意图"]
    ACTIVE --> INTENT
    INTENT --> SEND["QQ REST API 投递<br/>逐段保存真实回执；同一回答连续发送"]
    SEND --> ACK{"投递结果？"}
    ACK -->|确认成功| SENT["完成当前批次发送<br/>最终答案可通过 /result 再领取"]
    ACK -->|拒绝或未知| HOLD["停止当前批次剩余发送<br/>保留已完成模型结果<br/>不自动重发；可用 /result 领取"]
  end

  subgraph MEMORY["独立后台记忆：同房间按序整理，聊天可继续"]
    TRIGGER["群聊 50 条真人聊天 / 私聊 50 轮完整已发送问答<br/>或组装上下文含预留输出达到窗口 85%"] --> SNAP["捕获固定消息 ID、最后序号和画像快照<br/>持久任务、租约及分块进度"]
    SNAP --> EXTRACT["后台 LLM 提炼话题与人物 / AI 自身画像<br/>私聊额外生成续聊摘要；无独立群摘要"]
    EXTRACT --> COMMIT["核验来源、版本与租约<br/>事务提交画像、Topic、已处理 pending 和检查点<br/>原文保留；在途新增仍为未归档"]
    COMMIT --> RECALL["下次请求注入新画像与私聊摘要<br/>可选：Topic 向量化与语义召回<br/>未配置 Embedding 时压缩仍可用"]
  end
  CAP -->|能| LLM
  B -. "数量触发；仅在记忆启用时" .-> TRIGGER
  SENT -. "确认发送后检查私聊轮数" .-> TRIGGER
  CTX -. "达到 85% 则异步触发" .-> TRIGGER
  WAIT -. "超硬上限需等待" .-> TRIGGER

  classDef input fill:#eaf2ff,stroke:#648bb4,color:#17324d
  classDef agent fill:#e7f5ef,stroke:#4f9279,color:#163d31
  classDef output fill:#fff3df,stroke:#c79545,color:#5f421b
  classDef memory fill:#f0ebfa,stroke:#9780b9,color:#4c3a6c
  classDef guard fill:#fff8d9,stroke:#c39c3c,color:#53441d
  class A,B,OBS,TASK,ADMIN,RESULT,CTX,WAIT input
  class LLM,SAVE,TOOL,TOOLRESULT,PROGRESS agent
  class OUT,QUEUE,PASS,ACTIVE,INTENT,SEND,SENT,HOLD output
  class TRIGGER,SNAP,EXTRACT,COMMIT,RECALL memory
  class C,CMD,CAP,CHOICE,MODE,ACK guard
```

## 模块与存储边界

| 层 | 实现入口 | 职责与持久数据 |
|---|---|---|
| QQ 适配与服务启动 | [qq-channel.ts](../../src/qq-channel.ts)、[qq-cli.ts](../../src/qq-cli.ts) | 规范化真实发送者、@ 与引用，维护连接并执行 REST 投递；READY 后恢复任务。 |
| 调度与投递 | [channel-harness.ts](../../src/channel-harness.ts) | 白名单、去重、持久任务、并发计算、本地命令和每房间发送队列；计算完成与发送完成是不同状态。 |
| 上下文与业务记录 | [conversation.ts](../../src/conversation.ts)、[store.ts](../../src/store.ts) | SQLite 保存消息、actor/person 关联、模型输入、运行、工具回执、任务和投递；画像按人物共享，房间历史仍按来源限定。 |
| Pi 模型循环 | [runtime.ts](../../src/runtime.ts) | 每个渠道模型任务使用独立 Pi JSONL 与锁；SQLite 通过 run marker、entry ID 和 session 路径核对转录，不能混用不同任务的条目。 |
| 后台记忆 | [auto-memory.ts](../../src/auto-memory.ts)、[auto-memory-store.ts](../../src/auto-memory-store.ts)、[self-profile-store.ts](../../src/self-profile-store.ts) | SQLite 保存固定批次、租约、分块进度、人物与 AI 画像、Topic 和整理检查点；私聊另有续聊摘要。 |

队列只保证本机器人各回答的分段不互相插入，群友自己的消息仍可能出现。图中的“同房间发送”覆盖进度与最终答案；图中的“默认并发2”只限制前台任务，不把后台记忆整理塞进同一队列。

本地 CLI 是验证与离线管理入口，复用 Pi 和 SQLite，按 conversation 使用独占会话；其工具白名单为空，不经过 QQ 任务及投递队列。图中不把尚未实现的 Telegram、Web UI 或客户端协议合并转发画成现有能力。

## 默认上下文

固定总提示词与工具定义位于前部，动态背景使用清晰标签和 JSON。画像均有 `archived`（已归档）和 `pending`（未归档）；人物画像附 `personId` 和 `senderIds`，不注入旧的分类字段。本人自述与第三方笔记仍保留来源性质，避免错误归因。

群聊默认取当前发言者最近一轮已完成、已确认发送、未归档的问答，限定最近10分钟，并按 `runId` 配对。其他群友的闲聊不自动加入，更多原文由模型调用历史工具读取。私聊保留续聊摘要及未整理历史。当前问题真实 @ 的其他人物可注入其画像；普通文本人名不作为身份绑定。

默认加入固定总提示与工具定义、AI 自身画像、当前提问者及真实 @ 对象画像、共享记忆、可用时的相关 Topic、当前消息和精确引用。更长的群聊历史由 `read_history` 返回给同一 Pi 循环；程序不按自然语言句式猜测是否续问。`actor_id` 标记某人在某个房间的身份，`person_id` 汇总已确认的同一人物，不能按昵称合并。

## 循环、专业模式与存储

- 默认 `PA_LOOP_MAX_MODEL_CALLS=6`、`PA_LOOP_MAX_TOOL_CALLS=8`，不设整次总时限。`PA_TIMEOUT_MS`限制单个模型请求；网络工具和后台调用各有独立请求超时，主动取消仍可中止准备和工具等待。QQ的被动回复有效期属于平台投递约束，不是Agent循环计时。
- 最后一次模型调用去除工具，预留收尾；执行层再次检查，模型违规输出工具调用也不能突破上限。Schema 无效调用不产生业务写入。
- 深入回答在同一个 Pi 会话切换专业提示，继承身份、证据和剩余预算；最终专业答案直接保存发送，不再调用日常模式重写。提示变更通过 SDK 转录转换到各供应商协议。
- `web_search` 的摘要与来源留在工具结果中，来源可继续用于 `web_fetch` 核验；搜索回答不展示来源网址或自动追加参考链接。只读取网页且没有搜索的回答仍可附原网页URL。
- 所有渠道提问进入持久任务队列，`PA_MAX_CONCURRENT_TASKS` 默认2（范围1–16）；每问使用独立 Pi 转录和锁，SQL、人物画像和后台整理仍按真实房间与人物关联。计算完成就释放计算槽，等待发送不会占着它。每房间的发送队列一次发送整条回答，进度也经过这条队列；不同房间可以同时发送。
- QQ 的进度提示独立保存在 `run_progress`，不是人物证据。被动回复窗口内优先用原消息ID与下一个回复序号，进度和正文合计最多5个槽位；过期、槽位不足或完整答案需要超过剩余槽位时主动发送（不带 `msg_id`/`msg_seq`）。主动长答仍按500字符分段。临发送时重新判断窗口，发送前记录模式与槽位。拒绝或未知投递立即停止，不自动重发。
- `/result` 或 `/result 任务编号` 可领取当前房间中本人已完成的结果，不调用模型。主动答案附昵称、问题摘要和任务短编号。重启继续尚未开始模型处理的 queued；已有运行的失败、中断和未知投递不自动重跑，完成答案仍可领取。主动发送可能受QQ权限或平台额度限制，代码不绕过这些限制。
- 当前使用腾讯官方群/私聊消息接口，公开契约没有截图中的“合并转发聊天记录”消息结构。[官方发送文档](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/send.md)与[NapCat合并转发接口](https://napneko.github.io/onebot/api)属于不同接入方式；本次没有切换QQ客户端协议。
- 画像工具按真实来源消息和工具调用ID幂等，不能选择其他人物作为写入目标。只有工具成功提交后模型才能确认保存；之后模型请求失败也不回滚已提交画像。
- SQLite schema10迁移先备份，既有事实保留为已归档；历史分类元数据保留在旧审计记录，新画像和新产物不分类。后台只归档捕获且实际处理的 pending，跨房间版本检查避免旧任务覆盖新画像。

FTS5 索引覆盖原始消息，包括已经整理的历史。写入和索引维护在 SQLite 事务内；中文使用 Node 内置 `Intl.Segmenter` 分词，不增加运行依赖。BM25 是关键词排序，模型可以改写查询补检；不把它描述成向量语义检索。

## 验证范围

Mermaid 源文件与本文代码块一致，SVG 和 PNG 由同一源文件渲染并实际预览。图表示当前已实现流程；可选 Topic 向量召回需要另外配置 Embedding，不表示生产环境已启用它。

保留与身份、迁移、并发归档、事务、去重、取消、循环上限及QQ投递有关的检查。移除旧语义前缀、画像分类和独立判断/确认流程的测试，使用本地HTTP模拟模型工具协议及真实 Pi SDK/SQLite 验证整合；这些测试不证明真实模型的语义判断质量。
