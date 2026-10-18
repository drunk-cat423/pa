# pa

以 TypeScript 和 Pi SDK 构建的 Headless 长期个人伙伴。目标入口是 QQ / Telegram，记忆系统参考 Shiori 的思路，用 TypeScript 独立实现。

当前已实现 CLI、QQ 官方群聊/私聊、SQLite 原文与运行恢复，以及记忆 v1：统一人物画像、真实 @ 对象画像注入、固定批次后台整理、私聊续聊压缩和 Topic 中文关键词检索。后台默认关闭，需要明确配置模型预算；真实模型质量和 QQ mention 事件仍需联调。渠道可配置 DeepSeek 原生搜索，默认关闭；尚未接入 Telegram 或人格演化。

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
- `PA_CONTEXT_WINDOW` 是兼容接口的真实上下文容量配置；`PA_MAX_OUTPUT_TOKENS` 控制最大输出，`PA_TIMEOUT_MS` 控制单个模型请求超时。默认分别为 32768、2048、60000。整个工具循环默认最多6次模型请求、8次工具执行，不设总时间限制，配置见 `PA_LOOP_*`。

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

先按 [QQ 官方测试准备](docs/qq-official-test-setup.md) 保存凭证并加入测试群。群开启全量消息权限后，普通文本由harness保存；仅真实@或允许私聊才回复。群聊/私聊都保留最近一次成功的会话压缩摘要，以及检查点之后的全部真人消息与已确认送达的Bot回复，不再截取最近10条。消息带原发送者及回复对象，按可见顺序追加，当前问题另行提供；历史不构成新的保存或权限指令。固定摘要与历史放在动态画像、身份和时间之前，尽量复用请求前缀。更早的原文仍可由read_history按房间FTS5/BM25查询，每次最多10条。DeepSeek官方 `deepseek-flash` 已接入图片：QQ引用图片后 @Bot 提问，或平台提供的图文附件，会下载原图、保存SHA256 imageId并复用Files API句柄。非@图片及纯图片只入库，不触发聊天推理。图片与所属消息固定追加在同一压缩周期的历史位置；同图引用去重，摘要切换后旧图不自动注入，可用read_image按当前房间权限重新查看。文件和语音尚未接入模型。

此前 QQ 联调使用 DeepSeek 兼容接口并关闭深度思考。运行时以你实际填写的 provider、model、base URL 和窗口配置为准，密钥仅放在本机 .env，不发送到聊天或提交 Git。

QQ 回答使用原生 Markdown，长回答按 UTF-8 字节上限自动分段并连续发送，代码围栏在段边界保持有效。投递按段确认并按房间串行；未知或失败回执停止后续段，不自动重发。`/result` 可重新领取已完成的完整答案，不调用模型。原始 Markdown 作为一次 AI 回答进入滚动上下文；确认的分段保留各自引用索引。存储仍兼容旧分页记录，当前不提供分页指令或按钮。

`PA_QQ_ALLOWED_GROUPS` 使用官方 `group_openid` 白名单（不是数字群号），本地已填入先前验证成功的测试群。`PA_QQ_MAX_MODEL_CALLS` 沿用历史名称，实际限制问答任务数，默认3轮；每轮包含至少2次模型请求，另受PA_LOOP_MAX_MODEL_CALLS限制。填 `0` 则不限轮数持续运行；本地测试群已按用户要求设为 `0`，仍仅 @ 时调用。正数上限达到后退出。模型失败也计数，不自动重试同一消息；新 @ 消息仍可继续处理，数据库故障则停止。单次输出上限和超时仍生效，实际费用由供应商按输入、输出及缓存计费。

私聊使用 PA_QQ_ALLOWED_USERS 白名单，填写事件中的 author.user_openid；允许用户无需 @，未允许用户不保存、不调用模型。原文按房间存储，渠道提问使用各自独立的 Pi 会话，policy.json 的 primaryPerson 或 persons 将已确认的多个场景身份绑定到统一 person。绑定人物的画像跨群/私聊使用，ownerBindings 单独控制管理权限。[配置示例](docs/memory.md)

```powershell
npm run build
# 离线检查，不连接 QQ，不调用模型；key 为空时 ready=false，退出码 2。
node --env-file-if-exists=.env dist/qq-cli.js --check
# 填写 key 后启动；群内使用 QQ 的 @ 菜单选择机器人并发送文本。
node --env-file-if-exists=.env dist/qq-cli.js
```

各发送者的 AI 交互与画像分开取用；模型输入明确标记发言者、机器人回复对象和画像所属成员，昵称不能合并身份。历史工具默认查询当前房间当前发送者，群聊可查询本群；模型不能指定其他房间。全量消息和 @ 消息均按原文保存，模型输入另行记录。同一消息重复到达或服务重启不重新调用模型；未知发送结果记为 `uncertain`，不重发。

人物画像仅按当前提问者及本条问题真实 @ 的对象注入。只对 Topic 做中文FTS5/BM25关键词检索；当前不提供个人事件记忆或向量功能，也不提供删除操作或独立群情报摘要；群聊与私聊均保留用于续聊的压缩摘要。明确的本人更新与 owner 管理仍由 harness 鉴权。[记忆说明](docs/memory.md)

人物当前画像最多40条事实、每条200字符、正文合计6000字节、完整结构16000字节，每条最多5个代表来源。接近上限时在既有后台批次中收敛；成功处理的pending从内部队列移除，保留无正文回执、来源和旧版本。不会因为达到软线就单独发起模型调用，也不开放聊天删除入口。原始记录保留，当前每轮载入预算继续独立生效。

群数据共用业务记录，每次渠道提问使用独立 Pi 会话，模型上下文按当前发送者重建，防止其他成员画像或派生回复混入。明确纠正后停止注入旧背景；原始审计记录保留。

运行状态位于 `.local/pa/qq-service/status.json`，不记录凭证和消息正文。正常退出释放服务锁和会话锁；强制结束留下锁时，先确认对应 PID 已退出再移除。全量原文目前按现有本机数据策略保留，不自动删除。

## 后台记忆

AI自身与个人画像都只分“已归档”和“未归档”，不再按饮食、兴趣等内部字段分类。自然语言统一进入 Pi，模型先调用 `prepare_turn` 提交画像/群规则更新计划，再按真实保存回执回答；程序绑定真实发送者、核验原文并原子保存，成功后模型短确认。待归档内容下一轮生效，再随后台整理合并；只归档捕获快照中实际处理的条目，在途新增保留。所有接入成员均可建议修改 AI 全局画像，画像不能改变应用权限和工具配置。

确认调用预算后，在已有 .env 中设置 PA_MEMORY_ENABLED=true。群聊与私聊都只在最终上下文含预留输出达到实际模型窗口85%时整理，不再按50条/50轮触发。复用continuationSummary生成滚动会话摘要，覆盖固定快照，旧摘要与新增消息一起整理；成功后原子切换摘要及检查点，原文与在途新消息保留。后台处理与聊天并行，超硬上限则等待重建再发送。前置检查使用带余量的估算，不能替代真实模型窗口配置。

前台估算会依据成功响应的实际输入token校准，包含缓存部分，按接口、模型和房间隔离并跨任务/重启复用。未变化历史沿用实测值，新增内容保守计量；无有效样本或摘要替换等大幅变化时使用UTF-8字节备用估算。85%触发及发送前硬上限使用同一校准方式，仍保留输出、准备/工具结果和安全余量；缺失或全零usage不会被当作零占用。

PA_MEMORY_MAX_CALLS 限制每次启动所有房间共用的后台请求数，设为0可持续整理、不限调用次数；每个请求仍受超时限制，失败只允许操作者明确重排，不自动重试未知结果。Topic仅使用中文FTS5/BM25检索，不再读取Embedding配置或发出向量请求。配置、预算与离线任务诊断见 [记忆系统 v1](docs/memory.md)。

## 显式记忆

离线操作不需要模型密钥、不调用 AI。返回的 `memory.id` 是稳定 ID，纠正更新其 `revision`：

```powershell
npm start -- memory remember --conversation owner --kind fact --content '本群pa代表personal agent'
npm start -- memory query --conversation owner --query 'pa'
# 把返回的 memory.id 替换到 ID 位置。
npm start -- memory correct --conversation owner --id ID --content '本群pa统一指personal agent'
```

上述命令管理当前会话的群共享记录；me/user个人目标已停用，画像通过自然语言更新。在线保留 /remember、/memories、/correct；旧 /forget 或 delete 请求本地拒绝，原文和历史修订保留。自然画像更新直接使用 Pi 工具循环，无独立判断或确认模型请求；显式管理命令仍本地鉴权执行。离线管理仍不调用模型。

记忆纠正保留版本并更新当前值；明确绑定的人物画像统一使用。离线显式管理前须退出同名在线会话，原文仍可通过 history 查询。

## 数据和边界

默认运行数据在 `.local/pa`：`pa.sqlite` 保存原始消息、运行及投递记录；每个会话的 SHA-256 摘要目录内，`session.jsonl` 保存 Pi 模型上下文。SQLite 使用 Node 内置 `node:sqlite`，启用 WAL 和外键，未新增第三方驱动。

模型请求、响应及后台整理阶段另存于 `diagnostics/`，可用 `npm start -- logs task <任务ID>` 或 `logs job <批次ID>` 查询；`logs replay <callId> --offline` 只解析校验已有证据，不调用模型或写入业务数据。[统一日志与重放](docs/logging.md)

每轮先把用户消息与 running 记录写入 SQLite，再请求 Pi；回复入库后才输出到终端。两份记录用 run ID 和 Pi entry ID 对应。重开时核对未完成调用：有可验证回复则补齐业务记录，否则标为 interrupted；投递结果未确认则标为 uncertain。不会自动重试或重发。已关联历史不一致时停止并保留文件。[存储与恢复规则](docs/storage.md)

sent 表示发送端接受，不代表人已阅读。平台原文、模型输入和记忆派生记录分别保存；历史业务原文不会被压缩摘要覆盖。

会话有独占锁，防止两个 CLI 进程同时修改同一份历史。正常退出释放锁；强制结束进程可能留下锁。遇到这种情况，先确认对应进程已结束，再按错误中给出的路径移除锁文件；不要在仍运行时移除。

CLI 和后台记忆的工具白名单为空。渠道先强制prepare_turn，回答阶段只提供授权历史与网络工具；配置允许时同时提供 `web_search` 和 `web_fetch`，无需搜索前缀。网络工具内部保留摘要、原文及实际来源；搜索回答直接给结论，不展示来源网址或追加参考链接，搜索后读取网页核验也不附链接。单独读取网页仍可附原网页URL。prepare_turn的mode选择casual/standard/professional，耗时较长时可先发送一句进度提示；旧update_profile/answer_in_depth执行入口已移除。所有前台阶段共享6次模型、8次工具次数限制，不设整次总时限，最后一次模型请求关闭工具收尾。[完整流程图](docs/design/companion-tool-loop.md)

每轮前台请求在动态用户上下文中加入由运行服务器时钟生成的北京时间（含 `+08:00`）及 `Asia/Shanghai` 时区，包含在窗口估算和运行审计中；时间值不插入固定系统提示词与工具定义，保留固定前缀的缓存复用条件。原始用户消息仍单独保存。工具循环沿用本轮时间快照，下一轮重新生成。

主回复、专业回答和搜索摘要均按各自实际输出硬上限的约60%安排正文，留出完整收尾的余量；优先给结论、减少重复和冗长列举，确有未展开细节时才自然提示可继续追问。这是模型的长度指引，API 硬上限仍保留，不自动扩容或追加续写。长度指引随配置稳定，不包含每轮时间；搜索摘要遇到 `stop_reason=max_tokens` 或本地8000字符裁剪时返回 `summaryTruncated=true`，主模型只依据已取得的证据组织回复，不把截断列表当完整结果，也不自动续搜。该标记优先于摘要正文进入工具结果，避免长正文裁剪时丢失。

`web_search` 可填写北京时间的 `startDate` / `endDate`（有效 `YYYY-MM-DD`，含起止当天）；无时效要求时省略，不自动限制历史搜索。调用搜索助手时动态传入当前北京时间、范围及日期核验要求，不转发用户画像或群聊上下文。DeepSeek 尚未接入结构化日期过滤，这些范围仅作为查询提示；工具结果的 `freshness` 明确记录搜索时间、请求范围、`dateFilterApplied=false` 和 `verification=unverified`，不把生成摘要当作时效证据。原生 `page_age` 用 `pageUpdatedAt` 保留，不能冒充发布时间或事件日期；旧账本的 `publishedAt` 字段只为核算原有预算继续读取。`web_fetch` 返回抓取时间和页面声明的发布时间、修改时间、HTTP Last-Modified 证据，均未独立核验；没有日期就不推断最新。日期核验不自动增加搜索、重试或抓取，工具选择仍由 Pi 在现有预算内进行。

所有提问进入 SQLite 持久任务队列，PA_MAX_CONCURRENT_TASKS 默认2（范围1–16）。独立任务并行计算，完成即释放计算槽；同群按完整回答排队发送，进度不能插入另一条回答的分段中。QQ 回答以原生 Markdown 按最多1500 UTF-8字节自动分段；新鲜回复窗口最多用5个被动槽位，过期或分段超出槽位时转主动发送，并附问题与任务标识。主动发送仍受QQ权限和额度约束。每段按实际回执记录，拒绝或未知投递立即停止，重启不重发；/result 或 /result 任务编号可领取本人在当前房间已完成的完整结果，不调用模型。尚未启动的 queued 任务重启继续，已有运行的中断任务不自动重跑。

不加载全局 Skill、扩展或默认编码提示词。聊天自动重试及 Pi 自带自动压缩关闭；应用后台整理使用独立调用和持久任务，并通过 Pi 公开 API 切换活跃投影。

.env、.local、构建输出和依赖目录均已忽略。schema v18首次打开旧库前创建一致性备份，再事务迁移；平台撤回不删除数据库记录。升级保留现有聊天、旧画像版本、冻结批次和整理进度。旧count队列阻塞可通过本地维护命令退出旧执行流程，原文交给新容量压缩；不会自动退役或重跑旧任务，见[记忆说明](docs/memory.md)。

## 开发检查

```powershell
npm run check
npm test
```

测试使用 Node 内置测试工具、临时 SQLite 和本地 HTTP 服务，验证真实 Pi SDK 的多轮、恢复与隔离，以及消息事务、崩溃窗口和投递状态；不需要云端密钥、不产生 API 费用。测试回复仅存在于测试代码中，产品 CLI 不提供模拟聊天模式。

生产直接依赖：`@earendil-works/pi-coding-agent` **1.1.0**。开发依赖：TypeScript **7.0.2**、`@types/node` **24.19.2**。完整传递依赖由 `package-lock.json` 固定。

[Companion Memory v1 方案](docs/design/companion_memory_v1.md) 保留确认规则和验收依据；当前实现与使用限制见 [记忆说明](docs/memory.md)。

参见 [开发说明](docs/development.md)、[服务器部署](docs/deployment.md)、[Shiori 记忆参考映射](docs/shiori-memory-reference.md) 和 [v0.2 设计基线](docs/design/pi_evolving_companion_technical_design_v0.2.md)。

图片每张最多32MiB、每边4096px，支持JPEG/PNG/GIF/WebP；单请求最多600张、原图合计200MiB。85%上下文容量仍是整理主规则；图像API硬限制也会复用容量整理，不能静默删图。每图按1024 tokens保守预留并参加实测usage校准。签名下载URL和QQ auth_token不写入聊天、任务或普通日志；原图独立保存在 `PA_DATA_DIR/images`，Files句柄只优化传输，不保证供应商KV缓存命中。图片网络失败会给出简短原因，持久化失败停止会话。
