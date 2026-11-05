# 私聊委派执行器的服务器安装

执行器用现有订阅登录的 Codex CLI 运行服务器任务。固定模型 `gpt-6.1-sol`，推理强度 `high`。所有任务与子进程共用一个 systemd 服务的512MiB内存上限，串行领取，最多8个待执行或正在执行的任务。模型不可用、额度耗尽、命令失败都会成为该次执行结果，后续任务继续领取。

## 账号与配置

服务使用独立账号 `pa-codex-probe`，其HOME为`/var/lib/pa-codex-probe`。已有ChatGPT授权位于该HOME的`.codex`中。该目录由该账号持有、权限0700，凭证不进入仓库。服务主组为`pa`，通过`/run/pa-codex/worker.sock`与PA通信，socket权限0660。把`pa`组成员限制为产品服务和执行器账号。

复制仓库的`pa-codex-worker.service`到`/etc/systemd/system/`。将`pa-codex-worker.apparmor`复制到`/etc/apparmor.d/pa-codex-worker`并用`apparmor_parser -r`加载。这个具名profile仅给予该服务userns能力，Codex任务的命令仍受动态文件/网络权限限制，systemd另行隐藏生产配置和数据库。

`/etc/pa-codex-worker.env`由root持有，权限0600，包含以下绝对路径和已确认身份。示例中的占位符应由发布脚本计算。

```dotenv
PA_CODEX_STATE_DIR=/var/lib/pa-codex-probe/delegation
PA_CODEX_SOCKET=/run/pa-codex/worker.sock
PA_CODEX_OWNER=<唯一QQ私聊route与真实senderId数组的SHA256>
PA_CODEX_BIN=/opt/pa-codex-probe/node_modules/.bin/codex
PA_CODEX_SOURCE_DIR=/opt/pa/releases/<此次发布SHA>
PA_CODEX_MODULES_DIR=/opt/pa-codex-deps/<package-lock哈希>/node_modules
PA_CODEX_LOG_FILE=/run/pa-delegation-diagnostics/events.log
```

OWNER为`sha256(JSON.stringify([route.channel,route.accountId,route.roomType,route.roomId,senderId]))`，与PA端匹配。PA端仍核验真实的QQ私聊来源，执行器只接受该OWNER。这里的hash用于精确选择身份，socket的账号和文件权限负责本机访问控制。

依赖缓存从此次发布的实际`node_modules`复制一次，由root持有且不可组写。每个任务的`node_modules`只链接这个缓存，Codex命令仅有读取权限。缓存独立于普通发布保留规则，避免旧release被清理后续办任务失去编译依赖。发布时核验缓存和源目录来自同一份lockfile。源码目录在执行器启动时解开真实路径，任务记录实际源目录和新建的Git基线。

诊断日志由独立root维护的导出入口生成，应只包含授权PA服务、限定时间范围的脱敏事件。执行器账号不加入`systemd-journal`组。服务不持有部署、QQ或生产数据库凭证。发布新版本后更新SOURCE_DIR并重启执行器，正在执行的任务应先结束或明确中断。

## 结果与恢复

状态位于STATE_DIR的`tasks.json`，通过临时文件、flush及rename提交。任务按UUID建立独立工作目录，保留初始Git提交、实际差异及新增文件；源码副本排除env和生产数据。`results/<任务ID>-<revision>/`保存JSONL事件、调用模型参数、命令及退出码、最终说明和diff。正文不写入整个状态账本，历史修订仍可按requestId或revision查询。新建工作目录前要求磁盘余量至少2GiB。

第一次请求持久保存requestId，相同ID与相同内容返回同一接单结果，内容改变则拒绝。续办保持原任务目录、基线和精确Codex thread ID。每次修订保存独立结果，diff相对最初基线。执行器重启后，旧running标为interrupted，需要明确续办才会再次调用Codex。未知结果不会自动重新收费调用。内存超限时systemd结束该组进程，重启后同样标为interrupted。

检查服务时使用`systemctl status pa-codex-worker`及`systemctl show pa-codex-worker -p MemoryCurrent -p MemoryPeak -p MemoryMax -p NRestarts`。`MemoryPeak`包含执行器和任务全部子进程、文件缓存，不是单独模型的内存。Codex命令网络关闭，CLI本身沿指定代理访问模型。需要安装额外依赖或访问网络的任务可能受阻，按实际结果反馈，不自动扩大权限。

## 保留与维护

任务工作目录、续办会话和结果默认保留。发布的普通release轮换不负责删除这些用户改动；依赖缓存也不得在仍有工作目录引用时清理。此版本没有自动删除任务。维护时先停止`pa-codex-worker`，备份STATE_DIR、HOME中的Codex会话和被引用的依赖缓存。确认无需再续办的完整任务可以随同账本与会话快照归档到离线存储，恢复时成套恢复后再启动。不要只删`tasks.json`或重置running冒充成功。

服务启动后按单任务配置即可，不需要额外监听公网端口。HTTP接口仅通过Unix socket接受`POST /tasks`、`GET /tasks?owner=...`、按requestId恢复接单，以及`GET /tasks/<id>?owner=...&revision=N`。未过滤的列表最多返回最近50项元数据，历史产物按明确请求读取。
