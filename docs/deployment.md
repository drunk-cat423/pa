# Linux QQ 服务部署

PA 使用 Node.js 24.15.0、Pi SDK 和本地 SQLite，不需要 MySQL、Web 端口或 Nginx 代理。当前与 personal-page 共用 Ubuntu 24.04 服务器，博客及 Waline 保持原服务；PA 使用独立 Node，不能替换 Waline 的 Node 22。

| 项目 | 路径 |
|---|---|
| PA 发布代码 | `/opt/pa/releases/<git-sha>` |
| 生效代码 | `/opt/pa/current`，指向发布目录 |
| Node | `/opt/node-v24.15.0/bin/node` |
| 私有配置 | `/etc/pa/pa.env`，root 所有、600 |
| 数据与 Pi JSONL | `/var/lib/pa`，pa 用户所有、700 |
| 服务 | `pa.service`，模板见 `scripts/deployment/pa.service` |

代码、配置和数据分开。systemd 以 `pa` 用户运行，通过 EnvironmentFile 注入配置；`PA_DATA_DIR=/var/lib/pa`。服务只发起 QQ/模型 HTTPS 和 QQ WSS 出站，不需要新增安全组入站端口。保留本机已验证的机器人凭证、群白名单和模型预算；Topic当前仅使用关键词检索，不再读取Embedding配置，旧向量数据保留。

## 首次发布与数据迁移

发布包由已提交的 Git 版本生成，不包含 `.env`、`.local` 或 node_modules。在发布目录使用固定 lockfile 执行 `npm ci`、`npm run check` 和 `npm run build`；Node 下载包校验官方 SHA-256。服务器测试用 `node --test --test-concurrency=2 test/*.test.mjs`，不加载生产 `.env`，不请求真实模型。

先准备并验证代码，再正常停止本机 QQ 服务，防止两台机器同时连接同一机器人。停机后备份并复制整个 PA_DATA_DIR，包含 SQLite 和所有会话的 Pi JSONL；不能只迁移数据库。迁移副本中的 `conversations.pi_session_file` 从 Windows 路径改为 `/var/lib/pa/<原会话哈希>/session.jsonl`，原会话 ID、消息和 Pi entry ID 不变。保留迁移前副本，核对数据库完整性、外键和每个有关联消息的会话文件。

安装服务单元后：

```bash
systemd-analyze verify /etc/systemd/system/pa.service
systemctl daemon-reload
systemctl enable --now pa.service
systemctl status pa.service --no-pager
journalctl -u pa.service -n 30 --no-pager
```

`ready_waiting_for_mention` 表示 QQ Gateway 已就绪，不证明真实模型回答和记忆提取质量；在测试群实际 @ 机器人验证。状态文件是 `/var/lib/pa/qq-service/status.json`。服务重启会重置每次启动的聊天和后台调用计数，持久任务及整理水位保留。

服务以 `Restart=on-failure` 有限重启，SIGTERM 会正常关闭后台任务及会话。异常结束后，启动前脚本只移除已证实进程不存在的服务/会话锁；活动进程、无效锁或不明路径会阻止启动，不能跳过这些检查。V8 堆限制256 MB，systemd MemoryHigh384 MB、MemoryMax512 MB；这些是资源限制，不代表实测常驻用量。

## Detective 停用与恢复

保留 `/opt/detective-assistant` 的代码、venv、配置和 Chroma，以及 `/var/lib/mysql` 中的数据库。经确认 MySQL 没有其他业务库，且 Waline 使用独立 SQLite 后，可停用 Detective 后端和 MySQL：

```bash
supervisorctl stop detective
# 备份配置后，将 detective.conf 中的 autostart 和 autorestart 改为 false。
supervisorctl reread
supervisorctl update
systemctl disable --now mysql.service
```

只停止后端会使 Detective API 返回网关错误。暂停公开入口时，只修改共享 Nginx 文件中 `detective.linyouwei.top` 的 HTTPS server block，使普通请求返回503，并保留 ACME 验证路径及证书配置；博客和 Waline server block 保持原样。先备份，`nginx -t` 成功后再 reload。不得停用共享 Nginx 或 Waline。

恢复时开启 MySQL，把 Detective Supervisor 的自动启动配置恢复后启动程序，再恢复 Detective 子域路由；先核对保留代码、数据库和当前博客配置，不直接用陈旧的整份 Nginx 备份覆盖后续改动。

## 更新与回退

更新使用新的发布目录，完成构建和检查后停服务、备份数据，再切换 current 并启动。配置和数据不随发布包替换。若只有代码回退可兼容现有 schema，切回旧代码即可；schema 回退需要同一停机快照中的 SQLite 与 Pi JSONL 一起恢复，不能分别拼接。不要重新启动本机实例与服务器实例同时试用。
