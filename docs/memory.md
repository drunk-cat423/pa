# 记忆系统 v1

当前实现为 TypeScript / Pi SDK / Node 内置 SQLite。规则来源是 [逐项确认方案](design/companion_memory_v1.md)。代码已完成离线集成验证；后台默认关闭，真实整理模型与 Embedding 质量、QQ @ 对象的真实事件仍需联调。

## 人物、话题与原文

actor_id 保存某个人在某个房间的发言身份，person_id 汇总经过确认的同一人物。未绑定成员先使用独立人物记录，不按昵称合并。人物画像在绑定的群聊与私聊中共同使用，管理权限继续独立由 ownerBindings 决定。

`PA_DATA_DIR/policy.json` 保留原来的 primaryPerson，并允许多个 persons：

```json
{
  "version": 1,
  "ownerBindings": [],
  "persons": [
    {
      "id": "person_alice",
      "bindings": [
        {"route": {"channel": "qq", "accountId": "APP_ID", "roomType": "group", "roomId": "GROUP_OPENID"}, "senderId": "MEMBER_OPENID"},
        {"route": {"channel": "qq", "accountId": "APP_ID", "roomType": "private", "roomId": "USER_OPENID"}, "senderId": "USER_OPENID"}
      ]
    }
  ]
}
```

填写实际平台 ID；群成员 OpenID 和私聊 user_openid 不靠字符串相似度对应。绑定变更保留历史版本，已有独立人物归纳的事实会随明确绑定合入目标人物，较新明确事实优先。

每次回答只直接读取当前发送者和本条问题真实 @ 对象的画像，重复对象去重。普通文本人名、历史 @、@全体和 @Bot 不增加人物候选。画像按上下文预算取用完整事实，不做人物向量或 FTS 检索。

Topic 保存有原始消息 ID 的具体讨论；人物片段标记自述、第三方陈述或推断；画像是当前已归纳状态。只有 Topic 摘要参与 Embedding。原文按房间保存，人物画像共享不复制其他房间全部历史。

## 后台整理与并发

- 群聊每 50 条去重真人聊天消息；私聊每 50 个成功且已确认发送的完整问答触发。失败或未发送回复不凑轮数。
- 最终请求占用含输出预留达到窗口 85% 时也触发，可以不足 50。当前使用 UTF-8 字节量加协议/安全余量的保守估算，不把字符数当精确 Token 数。
- 固定消息 ID、起止序号和任务状态后再请求模型。新消息立即入库；后台与聊天独立，同房间整理按序，不同房间可并发。
- 成功时同一事务保存 Topic、片段、画像修订和检查点。失败保留原批次并有限重试，旧租约不能提交。过长批次拆分后持久保存子批次进度。
- 请求超过硬上限时，等待相关批次完成后重新构造请求；等待有截止时间。无可压缩历史或当前输入仍过长时返回失败，不发送超限请求。
- 私聊前 50 轮完整历史仍受容量线约束；之后用续聊摘要、画像、相关 Topic 和未归纳对话继续，原文保留。群聊没有独立群摘要。
- 正常关闭取消在途后台调用并重新排队；服务启动和巡检继续积压，不要求先收到新消息。失败任务不无限重试。

模型提案经过结构和来源检查；画像更新使用版本 CAS，旧批次不能覆盖较新自述。后台向模型提供有限画像视图，未展示旧事实由应用保留。

## 启用及预算

在已有 `.env` 中按 `.env.example` 补充：

```dotenv
PA_MEMORY_ENABLED=true
PA_MEMORY_MAX_CALLS=20
PA_MEMORY_TIMEOUT_MS=120000
PA_MEMORY_MAX_RETRIES=3
PA_MEMORY_MAX_OUTPUT_TOKENS=8192
```

启用会增加调用费用。后台复用聊天 provider/model，使用独立 ModelRuntime、输出预算和超时，不共享正在聊天的 Pi 会话。每次启动中所有房间共用 PA_MEMORY_MAX_CALLS，失败请求也计数，本地预检超限拆分不计实际请求。SDK 重试关闭，由持久任务控制重试。后台输出量还受实际模型上限和窗口四分之一限制。

可选话题语义召回需显式 Embedding 配置：

```dotenv
PA_EMBEDDING_URL=https://你的服务/v1/embeddings
PA_EMBEDDING_MODEL=服务实际模型ID
PA_EMBEDDING_API_KEY=自行填写
PA_EMBEDDING_DIMENSIONS=1024
PA_EMBEDDING_MAX_CALLS=100
```

端点须接受 `{model,input}` 并返回 `data[0].embedding`。向量必须维度正确、有限且非零。Topic 和查询向量共用每次启动的预算。向量保存于 SQLite，先按房间、模型、维度、输入版本和摘要 hash 过滤，再精确计算余弦相似度。没有新增依赖或独立向量服务，未做大规模索引性能承诺。

未配置 Embedding 时仍可整理话题、更新画像和压缩，语义召回返回 unavailable。更改模型/维度后后台逐批重建不匹配索引；更换同名但不同权重的服务时应使用可区分的模型标识，避免混用旧向量。

## 显式更新与管理

普通成员可明确更新自己的称呼、饮食、兴趣、回复偏好，例如“记住我喜欢登山”。不获得修改他人、导出全部档案或改变绑定的权限。

管理者保留 `/memory remember room|me|user:发送者ID 内容`、`/memory query`、`/memory correct ID 内容`；离线 CLI 保留 remember/query/correct。显式接口本身不请求模型。

```powershell
npm start -- memory remember --conversation owner --content '偏好中文交流'
npm start -- memory query --conversation owner --query '中文'
npm start -- memory correct --conversation owner --id ID --content '偏好简洁中文交流'
```

不提供 delete、/forget 或自然语言删除；旧命令本地拒绝，不擦除记录。平台撤回也不删除已保存原文。纠正保存修订并更新当前值；数据库记录“某人曾说过什么”，不把所有陈述自动视为已证实事实。

后台诊断与重试无需模型密钥：

```powershell
node --env-file-if-exists=.env dist/memory-jobs-cli.js status
node --env-file-if-exists=.env dist/memory-jobs-cli.js retry JOB_ID
```

retry 只重新排队，启用后台记忆的服务在巡检或下次启动时执行。状态输出含任务 ID、会话 ID、状态和次数，不含原文、画像或密钥。QQ 服务状态显示各房间任务数量、是否有续聊摘要和共享调用次数。

## 迁移与验证范围

schema v6 首次打开旧库时用 VACUUM INTO 创建同目录 `.v旧版本.UUID.bak` 一致性备份，再事务迁移。已有消息、绑定和修订保留，删除墓碑不自动恢复。数量触发不全量整理迁移前旧历史；当前会话确因历史超容量时，容量任务允许整理这些活跃历史。

离线测试使用临时 SQLite、本地 HTTP 和真实 Pi SDK，覆盖批次、并发、失败/重启、画像来源与版本、私聊连续性、容量等待、发送者/@画像、语义接口和向量版本。确定性模型与向量验证程序契约，不能证明真实模型提炼准确率。本轮开发未修改运行 `.env`、服务和业务数据库。
