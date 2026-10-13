# QQ Bot 能力与 pa 的映射

核验日期：2026-10-13。以官方当前开发文档为依据，结合 pa 的长期伙伴目标筛选。本轮只读取公开文档，没有调用机器人接口、发布菜单、修改群设置或请求模型。

## 结论

近期重点是私聊与群聊对话、发送者身份、引用上下文、显式记忆操作和可靠连接。全量消息与主动发送已经在当前测试群验证，后续可用于适度参与话题；自动判断、记忆整理和人格变化仍由 pa 自己实现。QQ 提供消息渠道和交互信号，不提供本项目的记忆与成长系统。

## 已确认的职责边界

用户明确：大部分工作交给 harness，QQ Bot 提供必要的渠道支持；通用能力不能绑定到某一个部署平台。

| 层 | 职责 |
|---|---|
| harness | 平台身份映射与作用域校验、会话与上下文、记忆四操作、Pi / 模型及工具执行、是否参与和何时主动、预算与冷却、业务存储和恢复。 |
| QQ 适配层 | 将平台消息转为通用输入，保留发送者、房间、@、引用和附件信息；报告渠道权限、发送窗口和能力限制；把 harness 的出站动作转为 QQ 请求，维护鉴权、心跳、重连并反馈投递结果。 |
| QQ 原生菜单／按钮 | 可选交互入口，只将用户操作规范化后交给 harness；不另写 QQ 专用的记忆、人格、调度或权限逻辑。 |

例如“记住我喜欢乌龙茶”从 QQ、Telegram 或 CLI 到达，都交给同一套记忆服务进行意图确认、作用域校验和持久化。QQ 的全量接收负责提供消息；保存哪些内容、是否请求模型、是否参与讨论由 harness 决定。harness 可以请求发送带 @ 的消息，QQ 适配层负责转成平台格式。

共用业务实现不意味着合并不同渠道或房间的数据。跨平台身份仍需明确绑定，群与私聊的隐私边界仍由 harness 执行。当前先复用现有 conversation / memory / runtime 服务，不为此一次性搭建完整新框架。

## 直接服务于伙伴体验的能力

| 能力 | 对 pa 的用途 | 当前证据与建议顺序 |
|---|---|---|
| 私聊与群聊文本收发 | 私聊陪伴、群内被明确叫到时回答 | 群内 @、普通消息接收、主动发送与多轮 AI 已实测；私聊 C2C 收发、无需 @ 和两轮 AI 上下文也已真人确认，隔离通过本地测试。第一批。 |
| 全量群消息事件 | 理解当前公共话题，判断是否适合参与 | GROUP_MESSAGE_CREATE 已实测；接收范围、保存范围和模型触发要分别控制。第一批先做有限近期上下文。 |
| 发送者与群标识 | 区分不同人、不同群；记录共同经历的来源 | 事件提供群/成员 OpenID、昵称及成员角色。使用稳定标识路由，昵称仅作展示。第一批。 |
| 引用消息接收与引用回复 | 理解“你说的这个”、明确回复哪条群消息 | 接收有 message_type=103 / msg_elements；发送有 message_reference。文档支持，待实测。第一批。 |
| 主动文本发送 | 低频插话、约定提醒、主动跟进 | 当前测试群已实测；真实主动策略需要冷却、静默、预算和许可。对话基础完成后推进。 |
| Markdown 和定向 @ | 清晰展示检索来源、记忆查询结果，明确回应对象 | 文档支持；群 @ 某人可用，群 @ 全体不能从频道能力推定。近期按实际客户端验证。 |
| 按钮与互动回调 | 把用户选择转成 harness 可处理的输入 | 可选适配，不作为通用功能的前置条件，暂不列入近期实现重点。 |
| 自定义菜单与指令面板 | 展示 harness 已有操作的便捷入口 | 可选适配；记忆、隐私和参与设置仍共用 harness 实现。 |
| 消息反馈 | 将点赞、点踩收为具体回复的反馈证据 | INTERACTION_CREATE type=13。文档支持；当前账号入口和实际事件待测。成长阶段使用。 |
| 图片、文件、语音等附件 | 分享图片时共同讨论，理解用户发来的材料 | 通道支持不等于模型会处理；先图片/文件，再按需要考虑语音。后续多模态阶段。 |
| 单聊流式输出 | 减少长回复的等待感 | 有独立 stream_messages 接口；群聊不支持流式。基础对话稳定后再接。 |
| 撤回自己发出的消息 | 及时纠正明显错误或重复输出 | 当前文档限制发送后 2 分钟；未实测。后续纠错辅助。 |

以上用途和顺序是工程建议；接口事实依据如下，未实测项目不能写成当前已可用。

- [全量群事件与字段](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)：用于发送者、群、引用、附件和来源定位。MessageScene.ext 还可能携带 auth_token 等鉴权数据，不能原样打印、写入普通日志或送进模型。
- [群消息发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)：文本、Markdown、键盘、引用回复和发送限制。输入消息 ID、用于引用的索引、返回消息 ID 应按用途区分。
- [文本交互](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/text-chain.html)：定向 @ 与可点击指令。该页部分条目仅频道可用，不能用于推定 QQ 群能力。
- [菜单与指令面板](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/menu-panel/)：为用户提供操作入口，不要求另建 Web UI。
- [单聊流式发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html)：独立的分片协议，需要记录首片返回 ID 与递增 index。
- [消息类型](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/overview.html)、[富媒体流程](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html)：附件由 attachments 提供；发送文件通常先上传取得 file_info，本地文件可走分片，不要求先搭公网文件服务器。单聊与群上传场景独立，file_info 有有效期。
- [撤回群消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages_message_id.delete.html)：普通成员可撤回自己发的消息；撤回其他成员消息需要管理员身份，不作为伙伴默认能力。

## 互动事件：特别适合后续成长和用户控制

[INTERACTION_CREATE](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/interaction_create.html) 不只包含按钮，还列出反馈、清空会话、模型切换和授权事件。订阅需要 INTERACTION（1<<26）；目前测试脚本只订阅群/单聊消息，尚未验证这些互动事件。

| 事件 | 可考虑的行为 | 必须明确的语义 |
|---|---|---|
| type=11/12：按钮／菜单 | 将用户选择交给 harness 的通用操作入口 | harness 校验操作者、房间、对象与去重，不把按钮文本当权限依据。 |
| type=13：点赞／点踩 | 关联具体机器人回复，形成可追溯反馈 | 单次反馈不能直接成为全局人格事实；入口是否对当前场景开放需实测。 |
| type=14：清空会话 | 考虑映射为当前模型上下文重置 | 不自动等同于删除聊天原文、长期记忆和全部备份。 |
| type=16：模型切换 | 经允许切换到配置内的模型 | 不能让群友扩大模型预算、修改凭证或随意指定供应商。 |
| type=18/19/20：用户／群授权与状态变化 | 更新主动发送许可，及时停止已被关闭的行为 | 仅按实际回调字段解释，不从页面操作或昵称猜测权限。 |

仅 type=11/12 需回复互动接口；[交互流程](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/overview.html) 给出指令回调类 3 秒窗口。先确认接收，再做较慢的业务处理；不能等模型完成才响应按钮。

消息反馈与频道的“表情表态”是不同能力。不要把频道表情接口当成 QQ 群点赞接口。

## 常驻运行必须具备的基础

[WebSocket 文档](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html) 提供 READY、心跳及 Resume/补发流程。近期需要连接状态、受控重连、持久化去重和出站确认；事件恢复不等于可以重发结果未知的群回复。

入群、移除和消息许可变化也应纳入生命周期处理。离群后停止该群任务，关闭主动权限后停止推送；不能只依靠一个永远不变的本地开关。[事件订阅说明](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html)

## 有价值但受权限限制的接口

| 接口 | 可用价值 | 当前限制 |
|---|---|---|
| GET /v2/groups/{group_openid}/info | 获取群名、简介等，帮助识别房间 | [文档明确仅白名单机器人可用](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_info.get.html)，无权限可能返回 11253。 |
| GET /v2/groups/{group_openid}/bot_state | 检查主动许可与接收设置 | [文档同样标白名单](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_bot_state.get.html)；recv_msg_setting 列出 all、only_mention、mention_and_context，后者具体上下文范围需另外实测。 |
| 群成员列表／信息 | 可帮助展示成员身份 | [2026-09-03 变更记录](https://bot.q.qq.com/wiki/develop/api-v2/changelog.html) 宣布接口新增；本轮未核对这些接口的完整参数和账号准入，不列为近期必需。 |

这些查询不能成为聊天功能的必经依赖。可先利用已授权消息事件里的发送者信息建立最小身份记录，不为“认识群友”先收集全群成员资料。

## 当前不纳入的能力

- 禁言、移除成员、入群审批和黑名单等群管理操作：目标是共同生活的伙伴，当前无相应产品需求或操作授权。
- 频道身份组、频道专属表情表态、频道 @ 全体：当前入口是普通 QQ 群，场景不同。
- 故事集、角色展示和其他产品专属功能：不符合当前无预设鲜明人格、无角色编辑器的方向。
- QQ 对旧历史的全面回溯：不能把收到引用/转发片段或短期 Resume 补发，理解成任意读取入群前历史的能力。我们自己的历史与记忆由已授权接收后的存储实现。

## 推荐接入顺序

1. 将当前 QQ 测试接成常驻适配层，支持规范化消息、@、全量接收、引用和发送结果；将输入交给 harness。
2. 在 harness 内完成平台身份/房间映射、消息去重、会话与业务存储集成，以及真实 AI 对话，验证跨人/跨群隔离。
3. 在 harness 内接入现有显式记忆四操作的通用入口，使 QQ、CLI 和未来 Telegram 复用；QQ 菜单/按钮不作为前置要求。
4. 对话基础稳定后，在 harness 实现低频参与、反馈候选与多模态处理；由渠道提供输入和执行出站动作。

此清单是调研与推荐，不是一次性实现全部接口的授权。文档目录有折叠项和不同年代说明；本轮按展开后的入口、具体接口页和最新变更交叉核对。部分加载超时页面通过 domcontentloaded 方式取得正文，未将加载失败当作接口不支持。
