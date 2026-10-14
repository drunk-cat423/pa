# 搜索接入与向量模型选择

核验日期：2026-10-14。DeepSeek 原生搜索已接入渠道 harness，可显式配置启用并设置持久预算；Embedding 凭据尚未配置。没有新增生产依赖。

## 网页搜索由 harness 提供

QQ 只传入问题和引用信息，通用的 `web_search` 能力由 harness 管理。当前使用 Node 原生 fetch 调用 DeepSeek 原生搜索，不引入 DeepSeek Harness/Cordis，也不修改 Pi 内核。

当前方案参考 [DeepSeek 搜索提供方源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/web/web-search-deepseek/src/provider.ts)：复用 PA_API_KEY，固定 POST `https://api.deepseek.com/anthropic/v1/messages`，携带 `web_search_20250305` 服务端工具。一次搜索是独立模型请求，增加输入、输出和缓存 token；分别解析结构化来源、存在时的引用摘录和接口生成的总结。总结交给主聊天模型组织回答，明确标为生成资料，不冒充原文摘录。没有成功结果块时报错，不解析模型编造的链接。搜索不会自动抓取 URL 或遍历网站。

启用配置见 `.env.example` 的 `PA_SEARCH_*`。`PA_SEARCH_BUDGET_ID` 标识持久请求账本，默认 `MAX_REQUESTS=0` 和 `MAX_USES=0` 表示不限次数；后者省略发送服务端 max_uses。也可配置正整数：MAX_REQUESTS限制账本中的累计尝试，MAX_USES发送给服务端；重启不重置，失败和未知请求也计入尝试。有限MAX_USES模式发现历史服务端计数超出后会保守暂停；不限模式不因旧试用账本暂停，也不删除账本。服务端usage计数可能包含被拒绝的工具调用，不能把它当成功搜索次数或费用硬上限。只有官方 DeepSeek 配置可以复用密钥；聊天不能改变这些设置。

已实现执行边界：

- 配置启用后，Pi可自主选择web_search或web_fetch；搜索查询由模型提供且不超过500字符，不再匹配自然语言前缀或强制tool_choice。CLI及后台记忆仍没有网络工具。
- 发送查询文本，不能把整个对话、画像或长期记忆当作搜索参数；网站内容是外部资料，不能改变身份、权限、工具或预算，也不能作为用户本人的自述来源。
- 固定官方端点、默认60秒搜索超时、默认最多5条结果；全部前台模型及工具调用共享6次模型请求和8次工具执行次数限制，不设整次总时限。搜索账本先通过独立锁与JSONL写盘并sync，再发送请求；无自动重试。查询和安全来源/usage保存在dataDir的预算目录，密钥不保存。完整流程见[工具循环](companion-tool-loop.md)。
- 原始响应最多1MiB，结果标题、摘录、URL均限长；网页资料不能修改权限或成为用户事实。模型用搜索总结和来源回答；harness 在末尾追加 `[参考链接]`，只列本次接口实际返回的来源 URL，QQ 以纯文本发送。
- Pi 工具消息已纳入会话加载校验，当前会话串行、取消由现有运行时处理；含工具结果的最终请求仍进行上下文硬限检查。持久化状态无法确认时停止会话。

备选 [Tavily Search](https://docs.tavily.com/api-reference/endpoint/search) 可提供专用检索接口，当前未实现。

### 按链接读取网页

渠道显式配置 `PA_FETCH_ENABLED=true` 后，当前用户直接发送一个 HTTP(S) 链接，或明确要求读取、打开、看看、总结一个链接时，只开放 `web_fetch`。群聊仍须真实 @ 机器人；私聊无需 @。搜索请求即使包含链接，也只开放搜索。引用、历史、画像、CLI 和后台整理不能开启网页工具。

每轮最多一次匿名 GET，不发送模型密钥、Cookie 或聊天记录，不执行网页 JavaScript。默认总超时15秒、响应最多1MiB、提取正文最多8000字符；读取成功后主模型回答，末尾附实际读取的链接。当前仅支持 UTF-8 HTML/纯文本，不支持重定向、登录页面操作、PDF或动态渲染。抓取本身不调用收费搜索，正文进入主模型上下文会增加普通对话 token。

连接前校验全部 DNS 地址并固定连接 IP，拒绝私网、回环、特殊用途地址及重定向，保留 HTTPS 主机证书验证。默认使用系统 DNS；TUN/Fake-IP 环境可显式设置 `PA_FETCH_PUBLIC_DNS=true`，固定通过 Cloudflare HTTPS DNS 查询网页域名，再进行相同地址校验，没有自动回退或重试。

### 长回复投递

harness 先将 QQ 回复转为纯文本并追加参考链接，再按约500个 Unicode 字符、优先段落和句子边界切分。QQ 群聊及私聊的同一入站消息最多允许5次被动回复；超过5段时增大单段长度，保留完整内容。每段使用不同 `msg_seq`，逐段记录发送状态；一段拒绝或结果未知就停止，重启不重发。500字符是切分目标，不是 QQ 官方单条文本长度上限。

### 首次真实联调

2026-10-14 复用现有官方 key，`scripts/search-trial.mjs` 经真实 Pi 工具循环搜索“DeepSeek 官方文档中 Claude Code 的 Web Search 支持与计费说明”。只发出1个独立搜索HTTP请求和2个主聊天请求，总耗时9738ms。解析后的前5条结果均为第三方，全部缺少引用摘录；最终回答如实说明无法据此确认官方结论，未补搜。首轮没有保存原始响应，不能据此断言接口未提供摘录。

usage 字段：搜索 input_tokens=9229、output_tokens=860、cache_read_input_tokens=384、cache_creation_input_tokens=0；按 Anthropic 分项口径合计10473。主模型两次合计1307，整轮合计11780；这是接口usage统计，未与DeepSeek平台账单对账。服务端 `web_search_requests=2`，超出请求中的 `max_uses=1`。测试后本地 `PA_SEARCH_ENABLED=false`，搜索额度未增加，普通QQ对话继续。结果可用但此次来源质量不足，不能将原生搜索次数参数视作可靠硬约束。

### 离线排查

同日按用户要求不再调用付费搜索。按首轮配置重建的辅助请求JSON只有339字节、查询62字符，不包含Pi会话或画像；大额token来自接口报告的服务端处理，无法从现有投影精确拆分内部提示、检索原文及迭代的占比。缓存分项相加与Pi的Anthropic适配器口径一致，账单尚未核对。

解析路径与DeepSeek Harness相同：原生结果块提供URL/标题，`text.citations[].cited_text`提供原文摘录。发现并离线复现了来源URL带`#main-container`但引用URL无锚点时关联失败的边界，已改为同页面关联（保留查询参数、不采信生成回答）。不能证明此边界导致了首轮问题，因为缺少原始响应。后续每次请求将在预算目录保存无认证头、密钥脱敏的`<attemptId>.request.json`及有大小上限的`<attemptId>.response.json`；落盘失败停止运行，不新增重试或额度。首轮缺失的原始响应不能重建或伪造。

### 原始响应复测

2026-10-14 经用户再次授权，只调用1个DeepSeek搜索HTTP请求，不调用主聊天模型、不重试、不更改常驻QQ搜索开关。独立预算保存在 `.local/search-trials/response-trial-71ae151a548045f6904f0313ab7a25b5`，原始请求、原始响应、账本和报告均保留。耗时6243ms；请求仅发送原问题，与首轮一致。

本次输入5337、缓存输入512、输出805、缓存写入0，按兼容协议合计6654 tokens。原始响应包含10个原生来源，字段为type/title/url/encrypted_content/page_age；没有明文snippet/content等字段。text块有1135字符模型总结，但没有citations；原始cited_text=0，解析后snippet=0。本次可以确认接口没有提供可直接使用的明文原文摘录，而不是解析丢弃。encrypted_content有27320字符，是协议返回的密文，不当作明文摘录；生成总结也不冒充原文引用。

原始响应有两个server_tool_use块及usage.web_search_requests=2；第一个结果块返回10个来源，第二个是web_search_tool_result_error/max_uses_exceeded。因此本次有次数拦截证据，报告2次调用不代表2次成功搜索；首轮仅凭计数推断max_uses失效的说法需保留不确定性。原始首轮已无法回查。本轮没有新增产品代码或测试，仅保存调试脚本/证据并更新说明。

[Tavily 当前价格](https://docs.tavily.com/documentation/api-credits)：每月1000免费 credits，不要求信用卡；basic 搜索每次1 credit、advanced每次2 credits，按量付费为0.008美元/credit。免费额度不替代程序自己的硬预算，初次联调不打开超额付费。

备选 [Brave Search API](https://brave.com/search/api/)：Search 当前为5美元/1000次，每月有5美元credits；免费订阅要求信用卡。可作为第二供应商，但先用本项目的中文问题检查结果质量和服务器可达性，再决定切换。

## 记忆整理和向量化分工

当前 `memory-provider.ts` 已将两者分开：DeepSeek 输出有来源消息ID的 Topic、人物片段、画像提案和私聊续聊摘要；Embedding 接口只给 Topic 摘要或检索问题生成向量。

向量不是聊天原文的替代品，也不能用来还原全部原文。“压缩对话”由整理模型完成，原始 SQLite 消息与 Pi 历史保留；“找出语义相关话题”由 Embedding 和相似度检索完成。人物画像按经过确认的 person_id 直接读取，不增加人物向量检索。

当前 SQLite 已保存 Topic 摘要、来源、版本及向量；检索先按当前会话、模型、维度、输入版本和内容hash过滤，再精确计算余弦相似度。先接通并测召回，不同时引入向量数据库和重排服务。

## 候选模型

[阿里云当前向量文档](https://help.aliyun.com/zh/model-studio/embedding)列出了以下北京地域文本模型：

| 候选 | 建议用途 | 初始维度 | 当前输入价格 |
|---|---|---|---|
| qwen3.7-text-embedding-flash | 首轮中文 Topic 检索评估，先控制成本 | 1024，默认值 | 0.000125元/千Token，约0.125元/百万Token |
| qwen3.7-text-embedding | 与 flash 在相同测试集比较召回质量 | 1024，默认值 | 0.0005元/千Token，约0.5元/百万Token |
| text-embedding-v4 | 现有服务只开放此型号时的备选 | 1024，默认值 | 0.0005元/千Token |

价格只指向量输入，另有聊天和记忆整理的模型费用；可用型号、地域和免费额度以实际账号为准。首选 flash 是工程判断，尚未用本项目的真实记忆做质量对比。

现有客户端接受 `{model,input}` 并要求 `data[0].embedding`。上述默认1024维适合直接沿用；任意更低维度不是只改本地验证值，必须同时向供应商发送受支持的 dimensions 参数。实际端点和凭据应按百炼工作空间获取，不能假设旧的公共域名对所有账号均适用。

开源自部署备选 [Qwen3-Embedding-0.6B](https://qwenlm.github.io/zh/blog/qwen3-embedding/) 支持1024维和多语言。若将来确需本地推理，可作为独立HTTP服务评估；当前不在 PA 内引入模型权重或 Python。也暂不增加 Reranker，先定位真实的召回遗漏。

## 验收顺序

先整理几十个有明确来源的 Topic，用约20个改写问题验证“同义表达、跨轮次、否定偏好、相似但不同的话题、无相关结果”。分别检查 Top-5 命中、误召回、响应延迟和调用次数；不同群与私聊的隔离是独立硬断言，不能通过相似度阈值实现。

选择型号后再填 PA_EMBEDDING_URL / MODEL / API_KEY / DIMENSIONS / MAX_CALLS。已有摘要在后台按版本补建向量，查询使用同一个型号；变更型号不能继续混用旧向量。真实收费测试前固定样本和最大调用次数。

## 本轮调研证据

公开搜索使用 Moli 的 DuckDuckGo 与百度结果定位官方资料；Brave搜索页面返回空正文，GitHub模型页面超时，改读Qwen官方博客。结论以已获取的 QQ、阿里云、Tavily 和 Brave 官方正文为依据，不将搜索摘要当作接口验收。
