# QQ 渠道调研

核验日期：2026-10-13。用户已确定 QQ 优先，且选择先试官方 Bot；Telegram 后续推进，NapCat 保留为权限不满足时的候选路线。本次核验公开文档与当前 pa 源码，未登录开放平台、安装 NapCat、登录 QQ、调用收费模型或向群发送消息。创建与进群操作见 [官方 Bot 测试准备](qq-official-test-setup.md)。

## 结论与路线建议

QQ 官方目前已有群聊 API，且文档明确包含全量群消息事件。不能再以“官方不支持群聊”为前提直接选择 NapCat。建议先用一个测试群验证官方 Bot 的实际账号权限；如果目标是以普通 QQ 账号加入现有群，或官方账号在目标群无法获得所需权限，再选择 NapCat。

| 比较项 | QQ 官方 Bot | NapCat / OneBot 11 |
|---|---|---|
| 身份 | 开放平台创建的机器人 | 登录 QQ 客户端的账号 |
| 群消息 | 支持 @ 消息；群主允许后可接收全部消息 | 提供群消息事件，应用自行过滤和触发 |
| 发送消息 | 群消息 API，受权限、频控和回复时效限制 | send_group_msg，由 QQ 客户端执行 |
| 本地连接 | 支持出站 WebSocket；也支持 HTTPS Webhook | 支持正向/反向 WebSocket，以及 HTTP |
| 部署 | pa 维护平台连接与凭证，不需要 QQ 客户端常驻 | pa 之外还需运行 NapCat 与 QQ，维持登录状态 |
| 身份标识 | App ID、群 OpenID、成员 OpenID | self_id、group_id、user_id |
| 主要限制 | 账号资质、服务范围及群授权需要实测 | QQ 版本适配、登录状态、掉线和账号风控需要维护 |

表中的平台能力来自下列来源；路线选择与部署建议是本项目的工程判断。

## 官方 Bot 的已核实能力

1. [消息收发概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html) 同时列出 QQ 单聊、群聊和频道。群聊接收事件有 GROUP_AT_MESSAGE_CREATE 与 GROUP_MESSAGE_CREATE。
2. [全量群消息事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html) 说明：开启接收全部消息后，未 @ 机器人的群消息也会上报。事件提供群和成员 OpenID，可用于路由，但不能按昵称猜测用户身份。
3. [官方 FAQ](https://bot.q.qq.com/wiki/bot_FAQ/) 的群聊问题说明：群主可在最新版手机 QQ 中设置全量接收与主动发言权限。该 FAQ 页面标注更新于 2026-10-09。
4. [发送群聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html) 提供 POST /v2/groups/{group_openid}/messages。被动回复窗口为 5 分钟，每条消息最多回复 5 次；群消息不支持流式输出。主动发送另有频控，收到消息不代表可以无限主动发言。
5. [接入指南](https://bot.q.qq.com/wiki/bot_new_product-intro/) 支持个人注册与认证、WebSocket 和 Webhook。WebSocket 可用于本地单机，不要求为了接收事件开放公网回调地址。接入时选择自行开发服务，无需引入 OpenClaw 或 Hermes。

### 仍需用实际账号核验的部分

官方页面对个人主体公开使用的描述不完全一致：接入指南列出个人认证后的公开使用和进群上限，FAQ 的部分问题仍描述个人权限陆续开放。不能据此保证任意个人账号都能把机器人加进任意群。

验证时检查：机器人创建入口、当前主体认证状态、目标群添加权限、群主的全量接收开关、主动发送开关，以及真实事件是否到达。优先用本人担任群主或管理员的测试群；不把旧版沙箱流程作为当前必经步骤。

官方事件中的 OpenID 与 NapCat 的 QQ 号不应直接合并。即使后续切换路线，也不能仅凭昵称把旧数据绑定到新用户。

## NapCat 的接入与运行要求

NapCat 使用 QQ 客户端的底层能力，并向外提供 OneBot 风格的消息收发接口。[项目说明](https://napneko.github.io/guide/napcat)、[源码仓库](https://github.com/NapNeko/NapCatQQ)

它负责 QQ 登录、消息事件和发送动作；pa 继续负责 Pi 调用、对话、存储与记忆。无需为了接入而再安装另一套 AI Bot 框架，也无需 Fork NapCat 或把其代码复制进 pa。

- [安装文档](https://napneko.github.io/guide/boot/Shell) 提供 Windows Shell 和一键包；Linux 可使用 Shell、安装器、AppImage 或 Docker。Linux 方案仍涉及 QQ 运行依赖，部分方案需要 Xvfb。Docker 是可选部署方式。
- [基础配置](https://napneko.github.io/config/basic) 明确区分 HTTP 服务端/事件上报客户端，以及正向/反向 WebSocket。推荐本地验证用正向 WS：NapCat 监听本机地址，pa 主动连接，一条连接接收事件并发送动作。
- 优先使用数组消息段，直接识别 text、at、reply；不能仅凭原始文本含有机器人的名字就判定为 @。先仅接受文本，其他消息类型暂不交给模型处理。
- [事件文档](https://napneko.github.io/onebot/event) 提供 self_id、group_id、user_id 和 message_id 等字段；[接口文档](https://napneko.github.io/onebot/api) 列出 send_group_msg、send_private_msg、get_login_info 和 get_status。正式开发时需锁定 NapCat 版本并核对该版本的事件与接口定义。
- [安全说明](https://napneko.github.io/other/security) 明确提醒账号风控和接口鉴权问题。建议专用测试 QQ 账号，OneBot 接口与 WebUI 仅本机访问并配置独立 Token；不要把测试机器人登录到日常主账号。掉线或发送失败不能通过重复请求模型来解决。

NapCat 文档部分概览较旧，其中网络介绍对 HTTP 角色的表述有混淆；具体连接配置以当前基础配置和锁定版本源码为准。

## 当前 pa 需要补齐的内容

当前 src/store.ts 的 schema v2 将 actor 固定为 local-owner，room 与 delivery 的 channel 限定为 cli。src/conversation.ts 的 prompt 只接收文本；记忆管理目前以 conversation 为权限范围。不能把群号拼进 CLI 会话名就视为完成 QQ 接入。

首个切片需要：

1. **平台身份与房间**：保存机器人账号、外部用户和群的真实路由标识。私聊按对方独立建会话，群聊按群建会话，群消息必须记录发送者。不同群、私聊和群聊互相隔离。
2. **接收过滤**：单个测试群白名单，首版仅 @ 触发；忽略机器人自己的消息、发送回声和未授权群。平台能够收到全部消息不等于应用已经获得旁听、永久保存或自动提取授权。
3. **入站去重与串行处理**：在数据库中持久化账号、房间、消息 ID 对应的去重记录；按会话排队，重复事件不再次请求模型。采用何种额外序号按锁定协议核验，不用文本哈希替代平台身份。
4. **出站确认**：回复先落库，再发送到原房间。保存平台返回的消息 ID；超时、断线或确认写盘失败时保留不确定状态，不盲目重发。OneBot echo 仅用于关联动作与响应，不是服务端去重保证。
5. **群记忆权限**：群内不能直接暴露现有离线 CLI 的任意记忆管理权限。先禁用群内记忆写改删；若后续启用，应补齐创建者、管理者和 SQL 权限校验。私聊记忆不得注入群会话。
6. **生命周期与配置**：区分连接在线、QQ 登录在线与模型请求成功；实现有上限的重连退避、队列边界和正常关闭。模型供应商与预算仍通过显式配置决定。

沿用现有 Pi 历史和 SQLite 恢复机制，保持工具白名单为空。新的身份及投递能力需明确 schema 迁移，保留现有 CLI 数据。新增生产依赖仍按项目规则另行确认。

## 下一步与验收

先验证官方 Bot 在测试群的可用权限，再确定单一路线；不同时建设两个 QQ adapter。若选择 NapCat，先在本机验证登录、事件接收与接口返回，再接入真实模型。

首个可交付结果是：一个授权测试群内 @ 机器人能完成三轮文本对话，重启后继续；另一群和私聊不串历史。验证还要覆盖重复事件、并发 @、机器人回声、掉线、发送确认未知、记忆越权以及陌生群消息。离线事件回放和本地接口测试先行，真实 QQ 与收费模型的结果单独记录。

当前 QQ 优先、先试官方 Bot 已确定。测试账号/群、模型供应商及预算、是否允许旁听仍未确定。
