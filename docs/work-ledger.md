# 工作台账：第一阶段实现

开发分支：`codex/work-ledger-proactivity`。schema32，尚未部署。

本阶段把[设计](design/work-ledger.md)中的任务持久化、授权、状态流转和通知恢复做成实际SQLite模块。只支持一次性提醒类型，不调用模型，不启动定时器，不自动创建历史任务；聊天工具和现有研究执行器尚未接线。

## 已实现的边界

- `work_items` 保存目标、原始消息、创建人物、原场景、明确提醒时间及版本。日期必须是带时区的有效ISO时间，首次创建必须在未来。
- `work_authorizations` 保存来源actor、person及路由。任务人物在创建后不随身份重绑转移；领取、完成、发送前复核当前绑定与允许场景。
- `work_attempts` 保存单次领取与60秒租约。SQLite短事务保证两个连接不会重复领取；过期token、旧版本或取消后迟到提交不能生成通知。
- `work_events` 追加状态与取消记录。取消不删除任务、原始消息或已有回执。
- `work_notifications` 与完成状态同事务保存。内部worker可有界查询queued通知，重新打开数据库后仍能发现；必须先预约sending再发送，只有真实确认才写sent。过期sending变uncertain，不自动重发。

任务幂等键为原始消息与action key，同一次请求重复提交只返回原任务；同key不同内容、或来源身份变化时拒绝。未过期租约不会被另一个连接的恢复过程抢走。

读写由当前真人消息解析实际person，不接受调用方提供owner。默认同场景管理，另外允许同一人物在绑定私聊之间管理；群内查询不展示该人物私聊或其他群的目标。明确跨群分享的授权入口留给后续阶段，不能因为画像共享而自动共享任务正文。

本地提醒的执行没有外部副作用，所以过期未完成领取可保留旧attempt并重新预约；这个恢复规则只能用于当前reminder类型，未来模型/研究执行器不得沿用它重发未知收费请求。已经预约发送的通知只会变为uncertain，不会自动回queued。

## 内部接口

`ConversationStore.workLedger` 提供：

| 接口 | 用途 |
| --- | --- |
| createReminder / listReminders / getReminder | 由真实来源消息绑定本人创建或查看 |
| cancelReminder | expectedVersion校验后取消；已经发送的通知保留真实状态 |
| claimDue | 按到期部分索引有界领取、复核身份和当前route白名单 |
| completeReminder | 校验lease/版本/当前授权后完成并生成通知 |
| listPendingNotifications | 重启后有界发现待发通知；不代表发送授权 |
| beginNotification / ackNotification | 发送前预约及发送后记录真实回执 |
| recoverAfterRestart | 仅处理过期本地领取与过期sending通知 |

这些是harness内部API，不是模型可直接调用的工具。worker必须检查begin返回状态为sending后才发送；拒绝授权不会被当成发送成功。静默时段、主动发送权限和定时唤醒属于下一阶段执行器接线，未实现之前不能宣称QQ已经能接受定时提醒。

## 升级及后续接线

schema31→32只新增work表、索引及独立`work-ledger=1`契约，不改旧聊天、画像、研究任务或其进度，不产生历史回填。旧库先备份；研究清理契约1继续可用，没有扩大清理范围。

下一阶段按顺序接入：一次性提醒的确定性唤醒与静默时间检查、同一输出通道的通知执行、本人聊天工具与保存回执、研究任务关联。研究仍复用原执行器和预算；不维护第二套研究循环，不让任务状态通过模型猜测。
