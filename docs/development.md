# 开发说明

当前实现遵循 [记忆 v1 确认方案](design/companion_memory_v1.md)，2026-10-16后续消融取消个人事件记忆和全部向量运行能力，旧数据保留；运行配置与命令见 [memory.md](memory.md)。后台模型默认关闭，离线验证完成后仍须分别确认真实模型预算及 QQ 事件。

## 模块与边界

| 文件 | 职责 |
|---|---|
| src/config.ts | 聊天与后台调用预算，不读取其他应用凭据 |
| src/runtime.ts | 受限 Pi 会话、独立 ModelRuntime 工厂、最终输入容量估算、公开 API 重建投影 |
| src/context-tokens.ts | 成功SDK输入用量校准、字段与正文细分指纹、旧样本核验升级、缓存统计校验及新增内容保守估算 |
| src/store.ts | schema v24、原文/run/投递、长回答文档与页面引用、显式记忆、迁移备份、去重和上下文水位 |
| src/research-tools.ts / src/research-service.ts | 模型研究工具、独立后台Pi循环、次数预算、受阻/恢复和正式报告投递 |
| src/research-store.ts / src/research-types.ts | 研究台账、北京时间统计、报告FTS、不可变版本文件、批次证据与投递幂等 |
| src/research-workflow.ts / src/research-workflow-store.ts / src/research-workflow-types.ts | 分阶段提示与协议、程序组装、schema25固定输入/章节版本/审查检查点、跨批恢复与完成门槛 |
| src/auto-memory-store.ts | 通用person绑定、可见消息序列、滚动摘要及容量快照、任务租约、子批次检查点、Topic/画像/关键词检索 |
| src/self-profile-store.ts | 全局AI画像修订、带来源待整理建议、原子归档和并发版本检查 |
| src/auto-memory.ts | 与聊天独立的后台调度、严格输出校验、显式失败重试、容量等待及 Topic 关键词检索 |
| src/memory-provider.ts | 独立 Pi 画像/Topic 提取请求 |
| src/profile-limits.ts / src/profile-pending.ts | 人物完整画像容量、处理回执及来源强度校验 |
| src/diagnostics.ts / src/logs.ts / src/logs-cli.ts | 独立诊断索引、请求响应证据、任务查询及无模型的离线解析校验 |
| src/conversation.ts | 原文与Pi关联恢复、群聊/私聊完整滚动上下文、当前发送者/@对象画像预算、85%容量触发 |
| src/channel-harness.ts | 先入库、按房间排队、参与判断、聊天预算、投递和启动后台恢复 |
| src/markdown-chunks.ts | 原生 Markdown 按 UTF-8 字节自动分段及代码围栏边界处理 |
| src/channel-types.ts / src/qq-channel.ts | 标准化发送者与真实 mention 目标、QQ 收发/鉴权/重连 |
| src/harness-policy.ts / src/memory-service.ts | 明确人物绑定、独立 owner 权限、本人显式更新及记忆管理 |
| src/cli.ts / src/memory.ts | 本地聊天和离线 remember/query/correct；拒绝删除 |
| src/memory-jobs-cli.ts | 无模型调用的任务状态查询、显式重排/搁置和旧count协议退役 |

沿用 NodeNext / ESM，内部 import 使用 .js 后缀。数据库采用Node内置node:sqlite，Topic在房间范围内使用FTS5/BM25；没有 ORM、Python 或新生产依赖。

渠道只提供身份、@、消息和传输；记忆、调度、权限与模型调用属于 harness。身份共享不授予管理权限。聊天和整理不共用活动 Pi Session；SQLite 写事务不跨模型等待。同一人物的后台提案使用 CAS 和证据时序检查，不能覆盖较新的明确纠正。

Pi 的默认自动压缩仍关闭。应用把版本化摘要和消息投影通过公开 API 接入 Pi，原文保持独立。不能直接替换 agent.state.messages，也不能忽略 SQLite / Pi 关联不一致。聊天重启不自动重发未知结果；后台整理依据持久批次和检查点重试。

QQ 回答使用原生 Markdown；长回答按 UTF-8 字节限制自动切段并连续发送。同房间投递串行，逐段确认；不确定或拒绝回执会停止余下部分，重启不自动重发。`/result` 显式领取完整结果，不调用模型。确认的分段保留消息 ID 与引用索引，引用按准确的房间和来源映射解析。旧分页文档与页面回执仍可读取，但当前 harness 不生成分页数据，也不响应 `/page`。

## 检查

```powershell
npm run check
npm test
```

测试使用临时目录、SQLite 和本地 HTTP，不调用外部模型、不消费生产凭据。当前套件按2026-10-21确认的规则精简：只保留本机开发记录中至少失败过一次的现存用例，包括有明确改名记录的延续用例。按具体用例筛选，不因文件中某一项失败就保留整个文件；仅有文件导入失败的记录，也不视为其中全部用例都失败过。已经移除的旧功能测试不恢复。

研究功能以 `research-e2e.test.mjs` 可观察端到端流程覆盖创建到文件发送，以及网络失败/显式继续/重启与未知投递恢复。2026-10-22按线上故障补充目标绑定、长报告/截断、伪调用与明确链接读取回归；`material-proposal-recovery.test.mjs` 检查被拒绝模型提案的原子搁置及不可降级边界。新增故障优先复用现有流程，避免镜像实现的测试。模型、网页与QQ接口使用本地模拟，真实意图判断和客户端展示仍需独立联调。研究的设计、预算和边界见 [research.md](research.md)。

失败记录可能来自实现、测试样例或旧断言，不等于每次都发现了产品缺陷。未找到失败记录的用例及不再使用的辅助代码已移除，当前套件不代表所有功能和边界都有覆盖。保留的回归按以下范围查找：

| 范围 | 主要测试文件 | 防止的故障 |
|---|---|---|
| 对话和工具循环 | `companion-loop`、`channel-harness`、`cli-interaction` | 准备与回答衔接、单轮失败后的继续对话、终端交互 |
| 上下文与用量校准 | `group-context`、`memory-context`、`context-tokens`、`runtime-token-calibration`、`calibrated-compression` | 已记录的历史注入、容量压缩和实测用量问题 |
| 画像与后台整理 | `auto-memory*`、`self-profile*`、`memory-diagnostics` | 已记录的画像注入、整理恢复及诊断保存问题 |
| 存储与消息投递 | `store`、`memory-store`、`channel-task-store`、`channel-async`、`delivery-parts`、`qq-channel` | 旧数据库升级、分段投递与引用处理 |
| 搜索、网页和图片 | `runtime-search*`、`channel-web-tools`、`web-fetch-proxy`、`image-context`、`markdown-chunks` | 搜索工具衔接、代理连接关闭、图片传递与代码围栏分段 |
| 运维与旧任务处理 | `pa-storage`、`legacy-count-retirement` | 备份清理计划、保留版本保护及旧计数任务退役 |

表中的名称均对应 `test/<名称>.test.mjs`。只检查相关模块时，先构建，再指定文件，例如：

```powershell
npm run build
node --test test/group-context.test.mjs test/context-tokens.test.mjs
```

后续优先为实际故障补充回归用例，说明触发条件和错误结果；同一入口、同一输入和同一结果不重复覆盖。迁移测试也按失败记录筛选，不整组保留。

Mock只验证程序契约。真实模型的人物归属、提取质量、关键词检索以及实际QQ @对象需独立联调。容量检查使用带余量的事前估算：成功usage校准只在收到响应后生效，未知新增文本仍保守计量，不等于对尚未发送请求进行供应商精确计数。

模型及后台整理的诊断字段、存储边界和离线重放命令见 [统一日志](logging.md)。保留的诊断回归聚焦曾失败的后台保存和提交阶段。

## 当前完成与后续边界

自动记忆 v1 及2026-10-16的统一对话准备已完成本地实现，参考 [存储规则](storage.md) 与 [循环协议](design/companion-tool-loop.md)。v11升级先备份再增加群规则、准备回执、pending用途与Topic全文索引，原文、冻结批次和旧记忆保留。服务器历史失败首因未能从旧通用错误恢复；离线重放只证明已修复的覆盖契约问题，不代表生产批次已经成功重跑。

src/turn-plan.ts集中管理intent/mode/updates协议及三种回答提示；channel harness传可信policy启用prepare_turn，画像作为软参考不反复复述。一般渠道对话含准备和回答两次模型请求，网络/历史续轮计入相同上限。真实模型的意图、自然表达与语义检索质量尚需按授权联调，当前不宣称已经改善线上聊天质量。

后台每次启动的调用上限由操作者明确设置。轻量自我画像已接入：所有成员的明确建议先保存并注入，再随记忆批次归档；没有独立关系模式、好感度或人格审批流程。Telegram、长回答合并转发和主动插话未在本次实现中。独立群情报摘要、人物 FTS/向量和删除功能已按用户决定排除；群聊/私聊的会话压缩摘要用于承接连续对话。

[v0.2 基线](design/pi_evolving_companion_technical_design_v0.2.md) 与 [Shiori 参考](shiori-memory-reference.md) 保留设计来源；发生冲突时以 [记忆 v1](design/companion_memory_v1.md) 和用户最新决定为准。

图片链路由 `image-assets.ts` 下载/验证/去重/保存原图并上传Files，`message_images`负责房间与消息关联；`image-context.ts`只依据harness可信metadata投影真正的DeepSeek user file blocks，同一投影用于估算和发送，不改Pi内部或伪造Base64图片文本。`image-context.test.mjs`用QQ真实字段fixture、CDN下载stub和本地HTTP模型验证准备/回答、完整图片历史、重启、后台冻结压缩、摘要切换、原图工具、跨群权限与关闭中的admission取消。后台画像专用任务不额外注入图片。
