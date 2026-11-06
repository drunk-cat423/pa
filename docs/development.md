当前数据与自动行为的完整说明见 [运行机制清单](runtime-state.md)。

# 开发说明

首次接手、按任务找模块、范围检查及交接见 [开发入口](repo-harness.md)。当前有效约定见根目录 [AGENTS.md](../AGENTS.md)，各主题文档说明实现边界；旧设计只作背景，不覆盖后续已确认的变更。运行模型、QQ 与后台任务需按实际配置及本次授权执行，离线检查不需要生产凭据。

本轮恢复边界与已确认问题见 [健壮性审查](robustness-review.md)。工具拒绝允许在原预算内修正，不能与持久化损坏、权限绕过或未知收费调用混为一类。

搜索短锁、研究计算/通知分离、增量SQL、图片与估算复用及初始化核验的边界见[效率修复](efficiency.md)。它们不改变两阶段和完整历史，也不代表已验证线上模型节费。

AI设定与个人偏好的纳入范围、模式与性格的关系及隔离回放边界见[画像归属与交流表达](profile-behavior.md)。

## 模块与边界

| 文件 | 职责 |
|---|---|
| src/config.ts | 聊天与后台调用预算，不读取其他应用凭据 |
| src/runtime.ts | 受限 Pi 会话、独立 ModelRuntime 工厂、最终输入容量估算、公开 API 重建投影 |
| src/context-tokens.ts | 成功SDK输入用量校准、字段与正文细分指纹、旧样本核验升级、缓存统计校验及新增内容保守估算 |
| src/store.ts | schema v33、原文/run/投递、独立失败回执、长回答文档与页面引用、显式记忆、迁移备份、去重和上下文水位 |
| src/context-people.ts / src/answer-grounding.ts | 稳定人物展示标签、真人经历来源与有界归属核验，标签不用于鉴权 |
| src/session-integrity.ts / src/session-integrity-store.ts | 已退出产品启动与调度的旧 Pi 离线审计工具，保留历史表和文件 |
| src/reminder-tools.ts / src/reminder-service.ts / src/work-ledger-store.ts | 本人一次性提醒工具、持久到期台账、原会话主动通知、取消与未知投递隔离 |
| src/research-tools.ts / src/research-service.ts | 模型研究工具、独立后台Pi循环、次数预算、受阻/恢复和正式报告投递 |
| src/research-store.ts / src/research-types.ts | 研究台账、北京时间统计、报告FTS、不可变版本文件、批次证据与投递幂等 |
| src/research-workflow.ts / src/research-workflow-store.ts / src/research-workflow-types.ts | 分阶段提示与协议、程序组装、schema25固定输入/章节版本/审查检查点、跨批恢复与完成门槛 |
| src/auto-memory-store.ts | 通用person绑定、可见消息序列、滚动摘要及容量快照、任务租约、子批次检查点、Topic/画像/关键词检索 |
| src/self-profile-store.ts | 全局AI画像修订、带来源待整理建议、原子归档和并发版本检查 |
| src/auto-memory.ts | 资料与压缩独立调度、组件失败隔离、有界退避恢复、容量等待及 Topic 关键词检索 |
| src/memory-provider.ts | 独立 Pi 画像/Topic 提取请求 |
| src/profile-limits.ts / src/profile-pending.ts | 人物完整画像容量、处理回执及来源强度校验 |
| src/profile-policy.ts | 即时保存与后台整理共用的画像纳入标准、AI长期关注课题边界 |
| src/diagnostics.ts / src/logs.ts / src/logs-cli.ts | 独立诊断索引、请求响应证据、任务查询及无模型的离线解析校验 |
| src/conversation.ts | 原文与Pi关联恢复、群聊/私聊完整滚动上下文、当前发送者/@对象画像预算、85%容量触发 |
| src/channel-harness.ts | 先入库、按房间排队、参与判断、聊天预算、投递和启动后台恢复 |
| src/markdown-chunks.ts | 原生 Markdown 按 UTF-8 字节自动分段及代码围栏边界处理 |
| src/channel-types.ts / src/qq-channel.ts | 标准化发送者与真实 mention 目标、QQ 收发/鉴权/重连 |
| src/harness-policy.ts / src/memory-service.ts | 明确人物绑定、独立 owner 权限、本人显式更新及记忆管理 |
| src/cli.ts / src/memory.ts | 本地聊天和离线 remember/query/correct；拒绝删除 |
| src/material-profile-wire.ts | 单人物最小提案、稳定事实引用、程序绑定来源及待办 |
| src/memory-jobs-cli.ts | 无模型调用的任务状态查询、显式重排/搁置和旧count协议退役 |

沿用 NodeNext / ESM，内部 import 使用 .js 后缀。数据库采用Node内置node:sqlite，Topic在房间范围内使用FTS5/BM25；没有 ORM、Python 或新生产依赖。

渠道只提供身份、@、消息和传输；记忆、调度、权限与模型调用属于 harness。身份共享不授予管理权限。聊天和整理不共用活动 Pi Session；SQLite 写事务不跨模型等待。同一人物的后台提案使用 CAS 和证据时序检查，不能覆盖较新的明确纠正。

Pi 的默认自动压缩仍关闭。应用把版本化摘要和消息投影通过公开 API 接入 Pi，原文保持独立。SQLite 是业务状态的唯一真相，Pi 使用内存会话，不再要求旧 JSONL 与业务数据双重核对。聊天重启不自动重发未知结果；后台整理依据持久批次和检查点重试。

QQ 回答使用原生 Markdown；长回答按 UTF-8 字节限制自动切段并连续发送。同房间投递串行，逐段确认；不确定或拒绝回执会停止余下部分，重启不自动重发。`/result` 显式领取完整结果，不调用模型。确认的分段保留消息 ID 与引用索引，引用按准确的房间和来源映射解析。旧分页文档与页面回执仍可读取，但当前 harness 不生成分页数据，也不响应 `/page`。

## 检查

测试只保留具体产品故障、用户明确提出的问题，以及少量会造成越权、原文丢失、重复付费或重复发送的关键检查。测试在编写时曾失败、基础功能验收或已经退出运行的旧机制，不是独立保留理由。逐项依据见 [test/regressions.json](../test/regressions.json)，取舍规则见 [测试保留说明](testing.md)。

```powershell
node scripts/repo-check.mjs --list
node scripts/repo-check.mjs memory
node scripts/repo-check.mjs --changed src/文件.ts test/新增.test.mjs --list
node scripts/repo-check.mjs all
```

检查入口先编译，再运行对应的现存测试；共享fixture变化仍选择所有现存回归。Mock和本地HTTP只证明程序行为，实际模型语义、QQ展示和线上延迟仍需独立验证。没有配置模型或QQ也可完成这些离线检查。

## 当前完成与后续边界

当前包含统一对话准备、两条记忆流水线、单人物增量提案与独立组件恢复，以及 SQLite 驱动的渠道调度，参考 [记忆](memory.md)、[存储](storage.md)、[循环协议](design/companion-tool-loop.md) 与 [启动和调度](startup-and-scheduling.md)。迁移保持原文、旧版本、冻结任务和审计；旧冻结协议与新任务分开处理。生产积压属于运行状态，应按诊断和任务库核对，不将某次维护的批次数写成当前系统事实。

src/turn-plan.ts集中管理intent/mode/updates协议及三种回答提示；channel harness传可信policy启用prepare_turn，画像作为软参考不反复复述。一般渠道对话含准备和回答两次模型请求，网络/历史续轮计入相同上限。真实模型的意图、自然表达与语义检索质量尚需按授权联调，当前不宣称已经改善线上聊天质量。

后台每次启动的调用上限由操作者明确设置。轻量自我画像已接入：所有成员的明确建议先保存并注入，再随记忆批次归档；没有独立关系模式、好感度或人格审批流程。Telegram、长回答合并转发和主动插话未在本次实现中。独立群情报摘要、人物 FTS/向量和删除功能已按用户决定排除；群聊/私聊的会话压缩摘要用于承接连续对话。

[v0.2 基线](design/pi_evolving_companion_technical_design_v0.2.md)、[记忆 v1 设计](design/companion_memory_v1.md) 与 [Shiori 参考](shiori-memory-reference.md) 保留设计来源；当前规则见根目录AGENTS和主题文档，用户最新决定优先。不要按旧设计重新引入已取消的向量或个人事件记忆功能。

当前默认仅本轮消息或本轮引用附件发送原图，历史和压缩仅保留元数据与已有识图回答；需要复看使用 `read_image`。图片链路由 `image-assets.ts` 下载/验证/去重/保存原图，`message_images`负责房间与消息关联。DeepSeek原平台上传Files，百炼V4.1从原图生成稳定Base64 `image_url`，不会上传到不支持该模型视觉的Files接口或发送旧平台句柄。`image-context.ts`只依据harness可信metadata投影真正的多模态块，同一投影用于估算和发送，图片字节不作为文本估算，不改Pi内部。`image-context.test.mjs`用QQ真实字段fixture、CDN下载stub和本地HTTP模型验证准备/回答、完整图片历史、重启、后台冻结压缩、摘要切换、原图工具、跨群权限与关闭中的admission取消。后台画像专用任务不额外注入图片。供应商参数、能力及边界见[模型供应商](model-providers.md)。
