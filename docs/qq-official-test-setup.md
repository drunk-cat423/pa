# QQ 官方 Bot 测试准备

核验日期：2026-10-13。用户已选择先试 QQ 官方接口。已实现独立扫码绑定和一次性群收发测试工具；它们不等于完整 QQ 对话渠道。真实通路的各步结果以本地运行状态为准。

## 推荐：第三方 Agent 扫码绑定

补充核验：用户指出官方 LightVela 接入说明后，确认官方提供扫码绑定入口。此前的手动 AppID / AppSecret 指引是一种可行方式，不是唯一流程。

[LightVela 自身指引](https://lightvela.com/docs/configuration/channel-qq) 同时支持扫码授权和手动凭证绑定。pa 是本地自建 Agent，接入时应参考同页的 [第三方 Agent 接入](https://bot.q.qq.com/wiki/agent-qqbot/#第三方-agent-接入)，无需注册或部署 LightVela / Hermes。

官方提供 @tencent-connect/qqbot-connector。当前公开包版本为 1.2.0，支持 Node.js 18 及以上；扫码授权后通过回调返回 appId 与 appSecret。它负责取得凭证，后续 QQ Gateway 连接、事件处理与发送仍由 pa 实现。[官方 SDK 包说明](https://www.npmjs.com/package/@tencent-connect/qqbot-connector)

推荐准备顺序：

1. 使用本地一次性扫码绑定工具，展示官方授权二维码或授权链接。任务级依赖放在忽略目录，不修改项目依赖清单；如正式纳入生产依赖，仍须按项目约定确认。
2. 用户用手机 QQ 扫码，按官方页面完成机器人授权；页面若要求创建或实名，由用户本人完成。
3. 回调取得的凭证直接保存到本地被忽略的配置，不在控制台、聊天或报告打印。官方示例的 console.log(AppSecret) 不应直接照用。
4. 机器人加入本人管理的测试群，再进行 WebSocket 连通性与 @ 事件验证。

默认扫码授权页显示接入方为“第三方机器人”；官方说明自定义展示平台名称或商务合作需另行联系。普通扫码接入没有要求先为 pa 申请定制名称。

扫码成功只表示凭证绑定完成，不代表群权限已验证、消息已收发或 AI 已接通。绑定状态以本地运行目录中的 status.json 为准，不以图片仍然显示就认为授权有效。

### 已实现的本地工具

```powershell
# 临时依赖安装到 Git 忽略目录，不改变根目录 package.json / lock。
npm install --prefix .local/qq-bind-tools --ignore-scripts --no-audit --no-fund @tencent-connect/qqbot-connector@1.2.0 qrcode@1.5.4
# 仅检查本地工具是否可用，不请求官方服务。
node scripts/qq-bind.mjs --check
# 请求官方授权任务，等待用户扫码。
node scripts/qq-bind.mjs
```

脚本保存 .local/qq-bind/<run-id>/qr.png 与不含凭证的 status.json；授权后仅更新 .env 的两个 QQ 字段，保留原有模型配置。二维码过期或等待超过 15 分钟停止，可重新启动；Ctrl+C 取消。运行过程中不要同时编辑 .env。

工具未实现 QQ 事件接收或消息发送，也不加载模型。临时依赖与运行文件、二维码、凭证均不提交 Git。

## 备选：手动创建与填写凭证

1. 升级手机 QQ，使用准备管理机器人的 QQ 账号。准备一个本人担任群主的测试群，先只邀请知情的测试成员。
2. 打开 [官方快捷创建入口](https://q.qq.com/qqbot/openclaw/login.html)，用手机 QQ 登录并点击创建机器人。入口名称包含 OpenClaw，但官方还支持自建服务使用 AppID / AppSecret 对接；pa 无需因此安装 OpenClaw。
3. 填写或修改头像、名称和简介，例如名称“伙伴测试”，简介“个人伙伴项目测试，仅响应群内 @”。遇到 AI 服务绑定时先跳过，按需选择稍后连接。
4. 如果需要完善主体或无法看到开发设置，进入 [QQ 开放平台](https://q.qq.com/#/apps) 按个人入口完成认证；实名信息与人脸验证由用户本人在官方页面提交。快捷创建与完整开发者入驻是两个流程，不要求先购买企业服务。
5. 在最新版手机 QQ 中将所创建的机器人添加到本人测试群。官方确认群主可添加自己创建的机器人，但公开文档没有给出所有客户端版本统一的按钮路径；先查看机器人资料卡和群管理中的机器人入口，找不到入口时核对手机版本、群主账号和主体状态。
6. 初测采用仅 @ 回复。暂不开启全量群消息接收和主动推送；机器人无须群管理员权限。后续若测试全量接收，由群主在机器人权限设置中明确启用，并另行决定应用的保存范围。
7. 在机器人管理端的开发设置中取得 AppID 与 AppSecret。事件与回调方式选 WebSocket；初测无需填写公网 HTTPS 回调地址。若设置了 IP 白名单，需要包含测试电脑实际出口 IPv4。
8. 将 AppID 与 AppSecret 写入本项目被 Git 忽略的 .env。预留字段是 PA_QQ_APP_ID 与 PA_QQ_APP_SECRET；这两个字段用于后续接入程序，目前 CLI 尚不读取它们。密钥不要发进聊天、截图或提交到仓库。

可告知的完成状态：机器人已创建、已加入测试群、WebSocket 已选择、凭证已在本地填写。不要用数字群号替代官方 group_openid；接入程序将从真实群事件取得路由标识。

管理员在新版管理端可直接测试，当前不需按旧教程配置沙箱群。pa 尚未连接时，机器人可能提示服务未在线；创建和进群成功不等于已接通 AI。

依据：[官方快捷创建及第三方接入](https://bot.q.qq.com/wiki/agent-qqbot/)、[机器人接入指南](https://bot.q.qq.com/wiki/bot_new_product-intro/)、[新版 FAQ](https://bot.q.qq.com/wiki/bot_FAQ/)、[主体入驻材料](https://q.qq.com/wiki/)。

## 费用核验

| 项目 | 本次核验结果与测试安排 |
|---|---|
| 创建机器人与基础消息 API | 官方公开接入文档未列出购买套餐、充值步骤或按调用次数收费的价格表。可以先进行创建和权限核验；没有价格表不等于对所有功能、账号或未来政策作免费承诺。 |
| 个人主体认证 | 入驻材料包括个人身份、手机号、QQ 和人脸验证；查到的入驻指引未列认证费用。实际认证页面如显示金额，须单独核对，不能把网上其他 QQ 产品的认证费用套用过来。 |
| 本地运行 | WebSocket 支持个人单机使用，本轮无须新增云服务器、域名或 HTTPS 回调服务。仍使用已有电脑和网络。 |
| 云端常驻 | 后续购买 VPS 或其他托管服务时才产生相应费用；官方页面的云部署推荐不是使用 QQ API 的必需购买项。 |
| 大模型 | QQ 只负责通信，模型由 pa 显式配置的供应商提供。费用取决于模型、输入输出 Token 和历史长度，尚未选定，不估算虚假的单价。 |
| 搜索、语音等扩展 | 当前测试不启用，不计入本轮预算。 |

上表是本次公开资料核验，不是已经检查过用户账号账单或购买页。资料来自 [创建指南](https://bot.q.qq.com/wiki/bot_new_product-intro/)、[平台入驻](https://q.qq.com/wiki/) 和 [消息规则](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)。

QQ API 的频控是接口限制，不应直接视为计费标准。群被动回复窗口为 5 分钟，每条消息最多回复 5 次；发送前应遵守实际平台权限和限制。

## 接入验证顺序

1. 使用本地凭证获取 Access Token、取得 Gateway、完成 WebSocket READY 与心跳；仅报告成功状态，不输出凭证。
2. 在测试群手动 @ 机器人，确认 GROUP_AT_MESSAGE_CREATE 到达并取得群/成员 OpenID；只记录必要测试数据。
3. 在本轮授权测试群回复固定的连通性文本，验证基础发送接口，无模型调用。
4. 完成 QQ 身份、房间、入站去重和出站确认实现及离线测试后，使用已确认的模型和预算进行三轮对话、重启续聊与隔离验证。

前 3 步是消息通路测试，第 4 步是 pa 的真实 AI 接入验收，不能混称为已完成。

### 群收发测试工具

```powershell
# 仅检查本地 QQ 凭证是否完整，不输出凭证或请求 QQ。
node scripts/qq-group-probe.mjs --check
# 真实鉴权、连接官方 Gateway，等待本轮随机测试码。
node scripts/qq-group-probe.mjs
```

工具在 Gateway READY 后显示 PA_TEST_ 开头的随机测试码。用户在授权测试群真正 @ 机器人，并发送完整测试码；仅第一条精确匹配事件会触发一次固定文本回复。私聊、普通消息、回声和其他文本均不处理或保存。

测试过程在 .local/qq-probe/<run-id> 保存明确选择的事件标识、群/成员 OpenID 与投递状态，不保存原始事件、聊天正文、Access Token 或 Secret。发送绑定原消息并使用固定 msg_seq=1；断线、响应不完整或投递不确定时停止，不自动重连、重试或重发。等待上限为 20 分钟。群里的实际收到结果仍需用户确认。

2026-10-13 实测完成：扫码授权成功，.env 两个 QQ 字段完整；用户确认机器人已加入测试群；Access Token 鉴权、Gateway READY 与心跳确认成功。测试群 GROUP_AT_MESSAGE_CREATE 已收到，固定文本回复获平台接受并返回消息 ID，用户确认在群中收到回复。运行编号为 219405dd-de86-4fa0-9515-75b278eb583f，证据保存在 .local/qq-probe/ 对应目录，收件确认单独记为 receipt-confirmation.json。

本轮仅验证 QQ 消息通路，没有调用模型；尚未实现 QQ 中的真实 AI 对话、身份与业务存储集成。工具完成一次回复后正常退出。npm run check、npm test 通过（63 项测试）；独立只读审查发现的未知投递归类问题已修复并回归验证。

### 全量消息与主动发送测试

用户要求继续测试这两项能力，并已确认在同一测试群开启“获取群内全部消息”和“允许主动发送消息”。这两项开关分别由群主控制，不需授予机器人群管理员权限。[官方权限说明](https://bot.q.qq.com/wiki/bot_FAQ/)

```powershell
node scripts/qq-group-probe.mjs --full 219405dd-de86-4fa0-9515-75b278eb583f
```

该模式从此前成功且已确认收件的运行记录取得群 OpenID，硬限定同一个群。Gateway READY 后会显示 PA_FULL_ 开头的新随机码，用户在该群直接发送普通文本，不 @ 任何人。仅 GROUP_MESSAGE_CREATE 的精确匹配码会被处理；不保存其他普通群消息。

收到普通测试消息后延迟 5 秒，发送一次固定测试文本。请求不携带 msg_id、event_id 或 msg_seq，用来验证平台的主动发送能力；这仍是受控测试，不涉及 AI 自主参与判断。取消或投递不确定时停止，不自动重发。

2026-10-13 实测完成：运行 a1e9e44f-2aff-441a-9082-a29c0a848133 收到同一测试群未 @ 的 GROUP_MESSAGE_CREATE，随后发送一次主动消息。发送请求确认不含 msg_id、event_id、msg_seq，平台返回成功消息 ID，用户确认实际收到主动测试文本；目标群与此前已验证群一致。运行状态为 active_accepted，用户确认写入该运行目录的 receipt-confirmation.json。测试程序正常退出，没有调用模型。

新增范围检查、主动请求格式检查通过；完整 npm run check、npm test 通过（65 项），独立只读审查未发现本轮实质问题。此结果证明该机器人在当前测试群已具备全量消息接收与主动发送权限，不代表已实现长期旁听、自动记忆提取或 AI 主动参与。
