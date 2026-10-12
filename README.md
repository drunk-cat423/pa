# pa

以 TypeScript 和 Pi SDK 构建的 Headless 长期个人伙伴。目标入口是 QQ / Telegram，记忆系统参考 Shiori 的思路，用 TypeScript 独立实现。

当前已实现本地 CLI 对话、SQLite 业务记录和显式长期记忆：会话恢复与隔离、消息和调用结果保存、中断核对，以及记住、查询、纠正、删除。没有预设性格；尚未接入 QQ / TG、自动记忆提取、搜索工具或人格演化。

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

## 显式记忆

离线操作不需要模型密钥、不调用 AI。返回的 `memory.id` 是稳定 ID，纠正更新其 `revision`：

```powershell
npm start -- memory remember --conversation owner --kind preference --content '我喜欢乌龙茶'
npm start -- memory query --conversation owner --query '茶'
# 把返回的 memory.id 替换到 ID 位置。
npm start -- memory correct --conversation owner --id ID --content '我现在更喜欢绿茶'
npm start -- memory delete --conversation owner --id ID
```

在线聊天也支持 `/remember 内容`、`/memories [关键词]`、`/correct ID 新内容` 和 `/forget ID`。指令直接执行记忆服务；普通聊天召回当前会话的有效记忆作为有限背景，不自动提取新记忆。

记忆按会话隔离。纠正保留版本审计，召回只使用当前版本；删除清空该记忆所有版本的数据库正文。纠正或删除会安排重置当前会话的模型上下文，下一轮前完成；原始聊天仍可通过 `history` 查询。离线管理前须退出同名在线会话。[记忆说明](docs/memory.md)

## 数据和边界

默认运行数据在 `.local/pa`：`pa.sqlite` 保存原始消息、运行及投递记录；每个会话的 SHA-256 摘要目录内，`session.jsonl` 保存 Pi 模型上下文。SQLite 使用 Node 内置 `node:sqlite`，启用 WAL 和外键，未新增第三方驱动。

每轮先把用户消息与 running 记录写入 SQLite，再请求 Pi；回复入库后才输出到终端。两份记录用 run ID 和 Pi entry ID 对应。重开时核对未完成调用：有可验证回复则补齐业务记录，否则标为 interrupted；投递结果未确认则标为 uncertain。不会自动重试或重发。已关联历史不一致时停止并保留文件。[存储与恢复规则](docs/storage.md)

`sent` 表示终端输出流已接受内容，不代表人已阅读。旧 Pi 历史不自动回填为业务记录；`history` 显示业务存储阶段开始保存的消息。消息原文和显式记忆分别保存，尚无自动提炼。

会话有独占锁，防止两个 CLI 进程同时修改同一份历史。正常退出释放锁；强制结束进程可能留下锁。遇到这种情况，先确认对应进程已结束，再按错误中给出的路径移除锁文件；不要在仍运行时移除。

运行时工具白名单为空，不加载全局 Skill、扩展、项目 `AGENTS.md` 或默认编码提示词。自动重试、自动压缩关闭，不在后台追加模型调用。当前不支持搜索、文件读写、Shell 或 MCP 工具。

`.env`、`.local`、构建输出和依赖目录均已忽略。数据默认保存在本机，没有后台整理或跨会话共享。记忆删除是应用层忘记；原始聊天、Pi 审计条目和旧备份仍保留，尚未实现聊天原文删除或保留期限策略。

## 开发检查

```powershell
npm run check
npm test
```

测试使用 Node 内置测试工具、临时 SQLite 和本地 HTTP 服务，验证真实 Pi SDK 的多轮、恢复与隔离，以及消息事务、崩溃窗口和投递状态；不需要云端密钥、不产生 API 费用。测试回复仅存在于测试代码中，产品 CLI 不提供模拟聊天模式。

生产直接依赖：`@earendil-works/pi-coding-agent` **1.1.0**。开发依赖：TypeScript **7.0.2**、`@types/node` **24.19.2**。完整传递依赖由 `package-lock.json` 固定。

参见 [开发说明](docs/development.md)、[Shiori 记忆参考映射](docs/shiori-memory-reference.md) 和 [v0.2 设计基线](docs/design/pi_evolving_companion_technical_design_v0.2.md)。
