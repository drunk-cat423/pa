# 显式记忆

首版参考 Shiori 的契约分层、查询域过滤和轮前召回思路，用 TypeScript 独立实现。只接受明确操作，不自动从聊天中提取，不通过 LLM 猜测删除对象。

## 四个操作

| 操作 | 行为 |
|---|---|
| remember | 保存完整正文、kind、stable ID、revision=1、explicit_user 来源及审计事件 |
| query | SQL 先限定 conversation，再查询 active；关键词是字面子串，空查询列最近记录 |
| correct | 同一 ID 创建新版本；旧版本 superseded，不参与召回，保留内容供审计 |
| delete | 标记 deleted，清空当前及全部历史版本的数据库正文；只保留 ID、版本、事件等元数据 |

支持 kind：fact、preference、episode。正文保留原字符串，拒绝空白，最多 4000 Unicode 码点。query 最多 1000 码点，limit 默认 20、范围 1–200。没有语义搜索或 FTS5；`%`、`_` 按普通字符查询。

作用域为当前内部 conversation ID，不能通过另一会话的记忆 ID 查询、修改、删除或引用。当前 CLI 会话键由本机 owner 指定，不代表平台认证；不自动共享同一 owner 的其他会话记忆。

每次明确写操作都有来源事件。可选 `--source-message-id` 关联当前会话的用户原文；不能引用模型回复或其他会话。`--expected-revision` 可防止旧查询结果覆盖新修改。纠正不更换 ID；重复删除幂等。

## CLI

离线无需供应商、模型或密钥配置：

```powershell
npm start -- memory remember --conversation owner --kind preference --content '我喜欢乌龙茶'
npm start -- memory query --conversation owner --query '茶' --limit 20
```

返回 JSON 包含 `scope` 和 `memory`。用其中的 `memory.id` 操作：

```powershell
npm start -- memory correct --conversation owner --id ID --content '我现在更喜欢绿茶' --expected-revision 1
npm start -- memory delete --conversation owner --id ID --expected-revision 2
```

在线指令为 `/remember 内容`、`/memories [关键词]`、`/correct ID 新内容`、`/forget ID`。操作不请求模型。离线和在线共用独占锁，先退出同名在线会话再运行离线管理；另一个会话可独立使用。

## 召回与纠错后的上下文

每轮模型请求前按当前 scope 查询。字面关键词未命中时回退最近有效记忆；选择最多 8 条完整记录，连同说明和 JSON 不超过 8000 字符。不截断数据库正文，不把记忆当权限指令。

记忆块通过 Pi 的 custom_message 追加到历史末尾，固定系统提示词保持稳定；每轮使用的 ID/版本与业务输入和 run 同一事务保存。

纠正和删除不仅改变查询结果，还设置 `reset_required` 与递增代次。下一次聊天前，通过 Pi 公开 `appendContextEdit(..., null)` 隐藏当前会话全部旧用户/助手消息与记忆注入块，再 `refreshContext()` 更新实际 Agent。因为旧回复可能间接重复记忆，首版选择整个模型上下文重置。原始 SQLite 聊天和 Pi 原条目保留，仍能审计；其他有效长期记忆会在下一轮重新召回。

顺序是 SQL 变更并置 pending → Pi 上下文修改持久化 → SQL 按代次确认。任一步失败会保留 pending 并停止模型调用，下次重开幂等重试；不会宣称已清理却继续发送旧上下文。

Pi 1.1 公开 API 无法编辑历史 compaction / branch_summary。当前未启用这些功能；若外部导入的会话含此类摘要，重置会明确停止，保留 pending，不忽略摘要继续调用模型。

这里的删除是应用层忘记。原始聊天、Pi 审计条目、旧备份仍保留，不等于擦除整段聊天或历史备份。离线返回 `contextResetRequired: true` 表示重置待执行；下一次聊天开始前完成。已有模型上下文会因此失去近期聊天连续性，可用 `history` 查看原文。

schema v2 通过 SQLite 事务从 v1 迁移，旧业务记录保持。没有新增生产依赖、后台提取、Embedding、人格模型或 Agent 记忆工具权限。
