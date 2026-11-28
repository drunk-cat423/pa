---
name: verify-pa-tasks
description: 查看 PA 任务协调器的阶段标准，通过隔离的本机服务验证已实现阶段并保存证据。
---

# PA 任务协调器验收

## Doctor

在仓库根目录运行 `node scripts/verify-pa-tasks.mjs doctor` 检查工作区、Node 和本地编译依赖。源码或测试不通过时，实际运行返回失败。

## Launch and drive

使用 `node scripts/verify-pa-tasks.mjs list-stage` 查看阶段依赖，`plan P1` 查看 V01 和 V02。用 `node scripts/verify-pa-tasks.mjs list` 查看已接入的可执行阶段。

`node scripts/verify-pa-tasks.mjs run P1` 将当前源码编译到临时目录，在本地 socket 上运行受认证的接单、重复请求、授权读取和并发续办，再核对 SQLite 结论与自动通知。它不启动 QQ 或调用模型。各阶段验收详见[设计清单](../../../docs/design/task-coordinator-verification.json)。

## Evidence and cleanup

命令输出证据目录，包含源码摘要、命令、退出码和 TAP 日志。临时数据库和 socket 由用例关闭，编译副本由 CLI 清理；核对 run.json 中的 outcome 与 scratchRemoved。plan 只展示验收条件。

使用 `node scripts/verify-pa-tasks.mjs run P2` 验证适配器选择、回报身份和不明确接单。本阶段使用受控适配器和内存尝试记录，持久调度另行验收。

使用 `node scripts/verify-pa-tasks.mjs run P3` 驱动双进程领取、外部回执等待、各层容量耗尽、跨发起人轮转及版本依赖。独立进程使用临时 SQLite，外部适配器受测试控制；报告包含实际执行区间和名额快照。

使用 `node scripts/verify-pa-tasks.mjs run P4`。测试以临时 SQLite 和可控时钟重开协调器，通过独立进程留下派发断点，核对外部执行计数、任务结论、占用及自动通知记录。受控 worker 的停止回执用于验证协调器处理证据的方式，真实供应商的停止能力需在接入时独立核验。

运行 `node scripts/verify-pa-tasks.mjs run P5` 验证版本文件、结案事务、分段投递中断和显式重领。传输端使用本地受控适配器，真实 QQ 入口待 P6 联调。

运行 `node scripts/verify-pa-tasks.mjs run P6` 验证本人 QQ 新建、续办、按版本重领、跨重启和切换；本机受控接口接收程序实际发出的模型请求、文件与消息。V12 对比空历史与一万条已结束记录的管理查询，记录索引、耗时分布、只读及正文隔离证据。
同一条 P6 命令还验证协调器停调后的巡检告警，以及含任务和文件的 v4 库升级、重开和恢复。旧库样本来自 P5 代码，只含合成数据。
