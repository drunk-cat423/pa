# 统一诊断日志

诊断记录放在 `PA_DATA_DIR/diagnostics/`（默认 `.local/pa/diagnostics/`），与业务数据库、原始聊天、Pi 会话及搜索预算账本分别管理。日志只供本地操作者排查；没有开放给模型或 QQ 群友的新工具，也不赋予画像、身份或记忆管理权限。

## 保存内容

| 位置 | 内容 |
|---|---|
| `index.sqlite` | 独立版本的调用和事件索引，可按 taskId、jobId、traceId、callId 精确查询 |
| `calls/<callId>/request.json` | 发送前的最终请求参数，经过密钥脱敏 |
| `calls/<callId>/response.json` | 收到的模型响应，先保存，再解析和校验 |
| `calls/<callId>/input.json` | 整理调用的冻结输入，或搜索解析所需参数 |
| `events/YYYY-MM-DD.jsonl` | UTC 日期分文件的阶段事件、固定错误类别和关联 ID，不重复写正文 |

主对话的 traceId 对应 runId，taskId 对应渠道任务；整理的 traceId、taskId、jobId 对应固定批次。同一次任务可以有多次模型调用，各有独立 callId；整理还保存 attempt。同一任务的准备、回答、工具、提取、校验、检查点和提交事件可串联查看。搜索子调用沿用提问任务关联信息，原预算账本与历史证据继续保留。

聊天和整理记录的 `captureLevel=sdk-normalized`：请求是 SDK onPayload 中实际提交的参数，响应是 SDK 汇总的消息，包含正文、思考/工具块、停止原因及 SDK usage；不宣称保留了底层 HTTP/SSE 原始字节。搜索为 `http-json`，保存接口 JSON 与参数，同样不表示原始网络字节或响应头全文。SDK 未暴露的字段、尚未收到的响应和进程崩溃后丢失的片段无法补造。

SDK 响应中的正文 JSON 解析失败、覆盖或来源校验失败，仍保留已取得的响应。搜索只保存通过限量读取取得的 JSON 对象；非 JSON 或超限响应留下失败阶段，不保存正文，也不声称取得了完整响应。后台失败阶段区分 request、response、parse、validate、checkpoint、commit；尚未取得完整结果的请求标为 unknown。`completed` 是该记录所标阶段完成，不证明整个业务提交或 QQ 投递成功，应同时查看任务事件和业务状态。进程突然退出留下 started 的记录，也不能当作未计费或安全重试的依据。

usage 标明来自 SDK 或供应商 JSON，`billedUsage=null`；它是排查数据，不是结算凭证。日志不改变模型次数、输出上限、搜索预算或自动重试策略。

## 查询与离线重放

先 `npm run build`，以下命令不需要模型密钥，不连接 QQ、不请求模型：

```powershell
npm start -- logs recent
npm start -- logs task <完整任务ID>
npm start -- logs job <完整整理批次ID>
npm start -- logs trace <完整traceID>
npm start -- logs call <callId>
# 显式读取正文；输出可能包含私密聊天及画像，分享前检查。
npm start -- logs call <callId> --content
npm start -- logs export <完整traceID> --content > trace.json
npm start -- logs replay <callId> --offline
```

默认只输出元数据及阶段事件。recent 最多30条，其余命令分别最多1000条调用/事件，`mayBeTruncated` 表明可能达到限制；不是完整归档导出器。直接执行 `node dist/logs-cli.js ...` 也可，使用相同 PA_DATA_DIR。没有日志的目录查询返回空，不创建索引。

离线重放验证证据哈希后，调用当前程序的纯解析和校验函数。整理重放使用当时冻结输入，检查结构、证据来源和消息覆盖；聊天检查响应/准备计划结构；搜索重新解析已保存的 JSON。输出明确标记 `offline=true`、`networkRequests=0`、`businessWrites=0`。缺少证据或哈希不一致则拒绝，不联网补齐。

重放不执行工具、不提交画像或记忆、不重新核验当前授权、版本 CAS、租约或投递，也不证明模型内容真实或检索结果新鲜。它不会把失败批次标为成功或重新排队；当前代码升级也可能改变旧记录的校验结果。

## 失败与数据边界

密钥、认证头和已知敏感字段脱敏；普通聊天正文和画像仍是私密数据，日志不能公开上传。目录在 Unix 使用0700、文件0600；Windows 对专用 diagnostics 根目录设置仅当前账号访问的继承 ACL，不修改业务目录 ACL。证据不可覆盖，并记录 SHA-256 和字节数；单份证据上限16 MiB，超出时明确失败，禁止静默裁剪后冒充完整记录。

诊断持久化失败会停止当前会话/后台工作器，不继续发起可能收费的请求。若业务提交已经成功，随后诊断写入失败不会倒退业务成功状态，也不重跑提取。日志索引、JSONL 与证据文件不是跨文件原子事务；崩溃可能留下孤立文件或缺少索引的事件，需结合业务数据库判断。当前按日分文件，不自动清理历史，也不新增删除入口；长期运行需留意磁盘容量。

既有12个排队批次仍保存原文、冻结输入和进度；搁置首个失败批次仅使它们恢复执行资格，不会自动完成提炼。后台暂停时不调用模型。操作者随后明确允许费用并启用 `PA_MEMORY_ENABLED=true`、重启服务后，后台恢复调度会按房间顺序领取未搁置批次，从已有检查点继续；批次可能拆分成多个模型请求，并非固定12次调用。失败或版本冲突仍按现有规则停止并交由操作者处理，不自动重试；首个搁置任务保持原失败状态和缺口。
