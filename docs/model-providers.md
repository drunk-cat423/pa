# 模型供应商

## 百炼 DeepSeek V4.1 Flash

2026-10-29 对北京工作空间的 `deepseek-v4.1-flash-1017` 完成文档核对及小额真实调用验证。PA 仍使用 Pi 的 OpenAI Chat Completions 工具循环，不更换 SDK。

```dotenv
PA_PROVIDER=bailian
PA_MODEL=deepseek-v4.1-flash-1017
PA_BASE_URL=https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
PA_API_KEY=在私有环境文件填写对应工作空间密钥
PA_CONTEXT_WINDOW=1000000
PA_MAX_OUTPUT_TOKENS=4096
PA_SEARCH_MODEL=deepseek-v4.1-flash-1017
```

复制控制台实际提供的地址，不把通用 DashScope 地址、原 DeepSeek 地址或其他地域密钥混用。前台、研究和记忆共用此模型配置，QQ凭证与网页代理保持独立。`model-capabilities.ts`集中处理已接入模型的参数差异；其他兼容服务不会自动获得这些能力。

| 能力 | 实际验证 / PA 使用方式 |
| --- | --- |
| 文本与SSE流式 | 已通过真实调用及Pi本地HTTP链路验证 |
| Function Calling | 强制指定函数及合法参数已通过；仍由Pi执行现有工具和次数限制 |
| 思考模式 | `enable_thinking=true`、`reasoning_effort=high`已通过；普通聊天和记忆显式false，研究high |
| 结构化输出 | `json_object`已通过，供记忆整理使用；不保证字段语义，仍做必要业务校验 |
| 严格JSON Schema | 真实接口返回400 `This response_format type is unavailable now`，不启用 |
| 图片 | 小型合成PNG已正确识别；使用稳定Data URI，不依赖QQ临时URL或旧平台file_id |
| 隐式缓存 | 两次合成前缀调用均报告5020输入token、4096缓存token；不承诺每次命中 |
| 原生联网搜索 | Anthropic兼容端点已返回真实搜索结果块及1次搜索用量，已接入PA的`web_search` |
| 百炼原生网页抓取 | 已通过API验证；需要开启思考，同时声明web_search。PA的`web_fetch`继续使用已有受地址校验和代理约束的HTTP读取器 |
| 百炼代码解释器 | Responses API真实执行1次并返回结果；需要开启思考，且不能与Function Calling混用。尚未作为PA聊天工具开放 |

模型卡列出1M上下文、最大384K输出；本项目保留前台4096、记忆配置上限及研究65536的明确输出预算，不自动使用平台的最大输出。原DeepSeek研究路径仍沿用其原请求语义。切换供应商会使用独立token校准键，旧平台的校准样本不会混入；旧缓存也不能跨平台搬运。后台流水线按新配置处理新调用，冻结任务及原文不改写。

图片本地仍保留最多32MiB原始文件。百炼传图限制为单图10MiB及请求体64MiB，容量包含Base64与文字；超限拒绝，不静默删除历史图片。超限新图的磁盘原字节保留，但失败附件不会加入可见图片历史。已保存旧图按原imageId和房间权限读取磁盘原件，不复制其他房间资料。Files API的文件ID目前用于Qwen文档模型和批任务，不能当作此模型的视觉句柄。

官方模型卡未支持的前缀续写、批量推理、调优不属于此次可用能力；不要因通用平台文档存在对应接口就宣称本模型可用。

## 接口依据

- [Chat Completions参数](https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)：`enable_thinking`、输出上限、工具及usage。
- [联网搜索](https://docs.bailian.console.aliyun.com/zh/model-studio/web-search)：北京工作空间Anthropic地址、服务端结果块和客户端标识要求。
- [视觉输入](https://docs.bailian.console.aliyun.com/zh/model-studio/vision)、[Files支持范围](https://docs.bailian.console.aliyun.com/zh/model-studio/openai-file-interface)。
- [上下文缓存](https://docs.bailian.console.aliyun.com/zh/model-studio/context-cache)：隐式缓存自动开启，达到最小长度不保证命中。
- [网页抓取](https://docs.bailian.console.aliyun.com/zh/model-studio/web-extractor)、[代码解释器](https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-code-interpreter)：需要的协议和模型范围。

内联图片不在每轮诊断中复制：诊断仅保存原始Data URI的SHA-256和字节数，原图仍在images目录。请求、token校准及缓存指纹均依据实际发送内容，诊断投影不改变模型输入。

原始API探针、凭据和生产配置保存在Git忽略目录或服务器私有配置中；本文只记录合成输入的结论。平台能力可能变化，换模型快照或协议时重新验证最终wire payload，复用`web/context/memory/cache`检查范围，不为能力清单另建一套重复测试。
