# pa

以 TypeScript 和 Pi SDK 构建的 Headless 长期个人伙伴。目标入口是 QQ / Telegram，记忆系统参考 Shiori 的思路，用 TypeScript 独立实现。

当前已实现 CLI、QQ 官方群聊/私聊、SQLite 原文与运行恢复，以及记忆 v1：统一人物画像、真实 @ 对象画像注入、固定批次后台整理、私聊续聊压缩和 Topic 语义检索接口。后台默认关闭，需要明确配置模型预算；真实模型质量和 QQ mention 事件仍需联调。尚未接入 Telegram、搜索工具或人格演化。

## 环境与启动

Node.js **24.15.0 或更高版本**，npm。已验证 Windows，本仓库不依赖 Python 或 detective 的环境。

```powershell
cd 'D:\personal project\pa'
npm ci
npm run build
Copy-Item .env.example .env
```

编辑 `.env`，填写 `PA_PROVIDER`、`PA_MODEL`、`PA_API_KEY`。供应商和模型未替你选择，不读取 Codex 或本机 Pi 的登录凭据。

- 使用 Pi 内置供应商：填写其 provider 与实际模型 ID，`PA_BASE_URL` 留空。
- 内置 Google Vertex 仅支持显式 API 密钥，拒绝会触发本机 ADC 的标记或占位密钥。
- 使用 **OpenAI Chat Completions 兼容接口**：填写 API 根地址到 `PA_BASE_URL`（通常以 `/v1` 结尾），`PA_PROVIDER` 为服务标识，`PA_MODEL` 为服务实际模型 ID；此模式不适用于仅支持 Responses 的端点。
- `PA_CONTEXT_WINDOW` 是兼容接口的真实上下文容量配置；`PA_MAX_OUTPUT_TOKENS` 控制最大输出，`PA_TIMEOUT_MS` 控制单轮超时。默认分别为 32768、2048、60000。

```powershell
npm run check:config
npm start
```

`check:config` 只检查配置格式，不请求外部模型；首次对话才验证模型和密钥。交互中使用 `/info` 查看会话状态、`/history` 查看最近 20 条业务消息、`/exit` 退出，Ctrl+C 取消并关闭。

```powershell
# 同名会话恢复历史，不同名字使用独立历史。
npm start -- --conversation owner
npm start -- --conversation another-person

# 单条消息，输出后退出；实际调用你配置的模型。
npm start -- --conversation owner --message '我们刚才聊到了什么？'

# 离线查询 SQLite 业务消息，不需要模型密钥，也不请求模型。
npm start -- history --conversation owner --limit 20
```

## QQ 群聊接入

先按 [QQ 官方测试准备](docs/qq-official-test-setup.md) 保存凭证并加入测试群。群开启全量消息权限后，普通文本由 harness 保存；仅明确 @ 时回复，模型背景由最多 8 条普通消息、当前发送者最多 12 条 AI 交互及有限有效记忆构成。图片、文件和语音尚未接入模型。群内文本不能修改配置、白名单、权限或预算。

此前 QQ 联调使用 DeepSeek 兼容接口并关闭深度思考。运行时以你实际填写的 provider、model、base URL 和窗口配置为准，密钥仅放在本机 .env，不发送到聊天或提交 Git。

`PA_QQ_ALLOWED_GROUPS` 使用官方 `group_openid` 白名单（不是数字群号），本地已填入先前验证成功的测试群。`PA_QQ_MAX_MODEL_CALLS` 默认 3，填 `0` 则不限次数持续运行；本地测试群已按用户要求设为 `0`，仍仅 @ 时调用。正数上限达到后退出。模型失败也计数，不自动重试同一消息；新 @ 消息仍可继续处理，数据库故障则停止。单次输出上限和超时仍生效，实际费用由供应商按输入、输出及缓存计费。

私聊使用 PA_QQ_ALLOWED_USERS 白名单，填写事件中的 author.user_openid；允许用户无需 @，未允许用户不保存、不调用模型。原文和 Pi 会话按房间存储，policy.json 的 primaryPerson 或 persons 将已确认的多个场景身份绑定到统一 person。绑定人物的画像跨群/私聊使用，ownerBindings 单独控制管理权限。[配置示例](docs/memory.md)

```powershell
npm run build
# 离线检查，不连接 QQ，不调用模型；key 为空时 ready=false，退出码 2。
node --env-file-if-exists=.env dist/qq-cli.js --check
# 填写 key 后启动；群内使用 QQ 的 @ 菜单选择机器人并发送文本。
node --env-file-if-exists=.env dist/qq-cli.js
```

同群成员共享允许公开的普通群背景，各发送者的 AI 交互与个人记忆分开取用；昵称不是授权凭据。全量消息和 @ 消息均按原文保存，模型输入的发送者及背景另行记录。同一消息重复到达或服务重启不重新调用模型；未知发送结果记为 `uncertain`，不重发。`sent` 表示 QQ API 返回消息 ID，真人是否收到需群内确认。

人物画像仅按当前提问者及本条问题真实 @ 的对象注入。只对 Topic 做语义检索；不做人物 FTS/向量检索，也不提供删除操作或独立群摘要。明确的本人更新与 owner 管理仍由 harness 鉴权。[记忆说明](docs/memory.md)

群数据共用业务记录，模型活跃上下文每轮按当前发送者重建，防止其他成员的画像及派生回复继续出现在共享 Pi 历史中。纠删后也截断旧 SQL 背景的重新注入；原始审计记录保留。

运行状态位于 `.local/pa/qq-service/status.json`，不记录凭证和消息正文。正常退出释放服务锁和会话锁；强制结束留下锁时，先确认对应 PID 已退出再移除。全量原文目前按现有本机数据策略保留，不自动删除。

## 后台记忆

确认调用预算后，在已有 .env 中设置 PA_MEMORY_ENABLED=true。群每50条真人消息、私聊每50轮完整问答，或最终上下文含预留输出达到85%时整理；后台处理与聊天并行，超硬上限则等待重建再发送。前置检查使用带余量的估算，不能替代真实模型窗口配置。

PA_MEMORY_MAX_CALLS 限制每次启动所有房间共用的后台请求数。Topic 向量检索还需填写 PA_EMBEDDING_URL、MODEL、API_KEY、DIMENSIONS；未配置时明确返回 unavailable，提取和压缩仍可用。配置、预算与离线任务诊断见 [记忆系统 v1](docs/memory.md)。

## 显式记忆

离线操作不需要模型密钥、不调用 AI。返回的 `memory.id` 是稳定 ID，纠正更新其 `revision`：

```powershell
npm start -- memory remember --conversation owner --kind preference --content '我喜欢乌龙茶'
npm start -- memory query --conversation owner --query '茶'
# 把返回的 memory.id 替换到 ID 位置。
npm start -- memory correct --conversation owner --id ID --content '我现在更喜欢绿茶'
```

在线保留 /remember、/memories、/correct；旧 /forget 或 delete 请求本地拒绝，原文和历史修订保留。显式管理本身不调用模型。

记忆纠正保留版本并更新当前值；明确绑定的人物画像统一使用。离线显式管理前须退出同名在线会话，原文仍可通过 history 查询。

## 数据和边界

默认运行数据在 `.local/pa`：`pa.sqlite` 保存原始消息、运行及投递记录；每个会话的 SHA-256 摘要目录内，`session.jsonl` 保存 Pi 模型上下文。SQLite 使用 Node 内置 `node:sqlite`，启用 WAL 和外键，未新增第三方驱动。

每轮先把用户消息与 running 记录写入 SQLite，再请求 Pi；回复入库后才输出到终端。两份记录用 run ID 和 Pi entry ID 对应。重开时核对未完成调用：有可验证回复则补齐业务记录，否则标为 interrupted；投递结果未确认则标为 uncertain。不会自动重试或重发。已关联历史不一致时停止并保留文件。[存储与恢复规则](docs/storage.md)

sent 表示发送端接受，不代表人已阅读。平台原文、模型输入和记忆派生记录分别保存；历史业务原文不会被压缩摘要覆盖。

会话有独占锁，防止两个 CLI 进程同时修改同一份历史。正常退出释放锁；强制结束进程可能留下锁。遇到这种情况，先确认对应进程已结束，再按错误中给出的路径移除锁文件；不要在仍运行时移除。

工具白名单为空，不加载全局 Skill、扩展或默认编码提示词。聊天自动重试及 Pi 自带自动压缩关闭；应用后台整理使用独立调用和持久任务，并通过 Pi 公开 API 切换活跃投影。

.env、.local、构建输出和依赖目录均已忽略。schema v6 首次打开旧库前创建一致性备份，再事务迁移；平台撤回不删除数据库记录。此次开发未修改实际运行配置或迁移实际业务库。

## 开发检查

```powershell
npm run check
npm test
```

测试使用 Node 内置测试工具、临时 SQLite 和本地 HTTP 服务，验证真实 Pi SDK 的多轮、恢复与隔离，以及消息事务、崩溃窗口和投递状态；不需要云端密钥、不产生 API 费用。测试回复仅存在于测试代码中，产品 CLI 不提供模拟聊天模式。

生产直接依赖：`@earendil-works/pi-coding-agent` **1.1.0**。开发依赖：TypeScript **7.0.2**、`@types/node` **24.19.2**。完整传递依赖由 `package-lock.json` 固定。

[Companion Memory v1 方案](docs/design/companion_memory_v1.md) 保留确认规则和验收依据；当前实现与使用限制见 [记忆说明](docs/memory.md)。

参见 [开发说明](docs/development.md)、[Shiori 记忆参考映射](docs/shiori-memory-reference.md) 和 [v0.2 设计基线](docs/design/pi_evolving_companion_technical_design_v0.2.md)。
