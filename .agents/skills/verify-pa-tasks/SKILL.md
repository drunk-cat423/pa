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
