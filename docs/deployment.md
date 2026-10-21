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

### 备份与发布保留规则

统一使用 `/usr/local/sbin/pa-storage`，实现和 systemd 模板在 `scripts/deployment/`。完整快照只写入 `/var/backups/pa/snapshots/`；不再在 `/root/pa-*` 下另建数据副本。每份快照保存整个数据目录的 `data.tar.gz`、对应代码的 `source.tar.gz`（不含 node_modules）、私有配置和服务单元。完成校验后才写入带 SHA-256 的 `manifest.json` 并原子发布目录；`.partial-*` 和未知格式目录不参与自动删除。

- 保留最近 **3 份完整快照**，并额外保留最近 **2 个标记过的升级检查点**，重叠只保留一份。检查点用于表结构迁移、资料流水线切换等需要恢复旧数据的操作；普通发布不标记检查点。
- 发布代码保留 **current 和最近 2 个其他版本**。正在运行的进程、保留版本通过 node_modules 链接依赖的版本会受到保护；不能为凑够数量删断引用。依赖链接原文含 `..` 分量，或目标的祖先目录也是软链时，轮换会拒绝执行；应先整理成指向真实发布目录中 node_modules 的绝对链接。
- 数据目录中的独立 `pa.sqlite.v*.bak` 仅保留最新 **1 份**，更早的迁移备份由完整快照覆盖。原始聊天、当前数据库、Pi JSONL、图片和诊断文件不由轮换程序删除。
- 每天服务器时间 **04:30** 运行轮换；发布成功后也可手工运行。删除前核验保留快照的校验和、当前发布及 PA 运行进程；检查失败则停止。轮换记录写入 journald，不调用模型。

安装运维入口和定时器（不修改 PA 服务单元）：

```bash
sudo install -d -m 700 /opt/pa/maintenance/storage /var/backups/pa/snapshots
sudo install -m 755 scripts/deployment/pa-storage.mjs /opt/pa/maintenance/storage/pa-storage.mjs
sudo install -m 755 scripts/deployment/pa-storage /usr/local/sbin/pa-storage
sudo install -m 644 scripts/deployment/pa-retention.service scripts/deployment/pa-retention.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pa-retention.timer
sudo pa-storage plan
```

发布、创建快照、切换 current 和轮换必须共用 `/run/lock/pa-storage.lock`。入口已取得该锁；执行整段发布脚本时应在外层取得一次锁，内部直接调用 Node 脚本，避免嵌套 flock。准备中的发布目录使用非 Git SHA 名称，构建完成后才改为最终 SHA 名称。先停止 PA，再创建快照；快照命令不会自行停止或启动服务，也不允许对正在运行的数据目录制作假定一致的副本：

```bash
sudo systemctl stop pa.service
sudo pa-storage backup
# 涉及需要回退数据的升级时，改用 backup --checkpoint before-schema-N。
# 完成升级、切换 current 并启动 PA，确认正常后再执行：
sudo pa-storage prune --apply
sudo systemctl list-timers pa-retention.timer
sudo journalctl -u pa-retention.service -n 20 --no-pager
```

恢复时先停止 PA，把同一快照中的数据库和 Pi 文件作为整个数据目录恢复，不能与现有会话文件混用；按需恢复该份配置及服务单元。旧发布目录已轮换时，使用同份 `source.tar.gz` 和 lockfile 重建依赖。升级检查点不是当前消息的副本，恢复旧快照会失去快照之后的变化。这些快照保存在同一台服务器，仅用于回退，不等于异地备份。

## PA 网页读取代理

Mihomo 作为独立的 `mihomo-pa.service` 运行，只监听 `127.0.0.1:17890`，不启用 TUN、系统代理或公网代理入口。安装二进制位于 `/opt/mihomo-pa/mihomo`，私有配置位于 `/etc/mihomo-pa/config.yaml`，订阅缓存及节点选择位于 `/var/lib/mihomo-pa`。服务和不含凭证的配置模板见 `scripts/deployment/mihomo-pa.service`、`scripts/deployment/mihomo-pa.example.yaml`。安装时校验官方发布文件的 SHA-256；私有配置使用 root:mihomo-pa、640，缓存目录只允许服务账号访问。订阅每天直接刷新，已有缓存供重启时使用；真实订阅地址和节点凭证不得进入代码仓库或日志输出。

`PA-Proxy` 使用 `url-test` 自动选线：每60秒进行一次HTTPS健康检查，单次5秒超时、要求HTTP 204；当前节点可用时，延迟改善超过100ms才切换，当前节点不可用时重新选择可用线路。节点由 `use: [subscription]` 引入，因此实际定时探测必须同时配置在 `proxy-providers.subscription.health-check`，不能只修改组的 `interval`。provider与组都筛掉流量/到期信息等占位项，`lazy: false` 保持空闲时也持续探测。内核的选线结果最多缓存10秒，探测失败后切换可能有短暂延迟。探测结果只代表测试地址当时的连通性和延迟；换线作用于后续连接，现有抓取不会自动续传或重试。字段语义见 [Mihomo自动选择](https://wiki.metacubex.one/config/proxy-groups/url-test/)、[代理组健康检查](https://wiki.metacubex.one/config/proxy-groups/#url)和[v1.19.32选线实现](https://github.com/MetaCubeX/mihomo/blob/v1.19.32/adapter/outboundgroup/urltest.go)。

从手选组升级时，还需通过 Unix 控制接口调用 `DELETE /proxies/PA-Proxy`，清除并持久化该组之前保存的固定选择。验收要确认组的 `type=URLTest` 且 `fixed` 为空，热重载后仍为空，并实测故障探测后的自动换线；仅修改类型或看到定时测速记录不能证明已经解除手动固定。此操作只清除该组的选线偏好，不删除订阅、缓存文件或其他组。

在 `/etc/pa/pa.env` 设置 `PA_FETCH_PROXY_URL=http://127.0.0.1:17890`；需要通过公共 DNS 解析网页目标时，同时设置 `PA_FETCH_PUBLIC_DNS=true`。这两个配置仅作用于 `web_fetch` 及其 DNS 查询，不配置 `HTTP_PROXY`、`HTTPS_PROXY` 或全局网络 agent。QQ Gateway、QQ API、DeepSeek 模型/整理/搜索 API 及图片上传继续使用原连接。DeepSeek 服务端原生搜索的出站网络由 DeepSeek 控制，不经过 PA 的代理。

网页读取先解析并检查目标地址，再用 HTTP CONNECT 连接已验证的公网 IP；TLS 的服务器名、证书校验和 HTTP Host 保留原网页域名。代理不重新解析网页域名；内网地址、重定向和现有响应大小限制仍按原规则拒绝。代理连接失败时返回工具错误，不自动重试或改成直连。当前只支持无认证、无路径/查询/片段的 HTTP 代理 URL。

验证时分别检查：Mihomo 仅监听回环；以 pa 用户调用实际 `fetchWebPage` 读取外网正文及公共 DNS；非公网地址仍被拒绝；PA 进程没有全局代理变量，QQ 重新就绪且 DeepSeek API 仍可直连。控制接口仅提供本机 Unix socket `/run/mihomo-pa/controller.sock`，可由服务器操作者检查节点及连接，不开放 HTTP 管理端口。此次接入无需修改 Nginx、Waline 或安全组。

回退时先将 PA 切回此前发布并恢复对应配置，确认 QQ 就绪后，再停用 `mihomo-pa.service`；不修改数据库、摘要或任务水位。

### 旧计数队列退出

升级到含schema v16的发布后，若仍有旧count任务阻塞，先停PA服务、备份整个 `/var/lib/pa` 及配置；在服务保持停止时，以pa用户运行维护命令：

```bash
sudo -u pa env PA_DATA_DIR=/var/lib/pa /opt/node-v24.15.0/bin/node /opt/pa/current/dist/memory-jobs-cli.js retire-count CONVERSATION_ID '旧计数任务退出执行，原文交85%滚动容量压缩'
```

此命令不需要模型/QQ凭证，不调用模型。只支持该会话首次rolling快照前的无租约queued/failed旧count任务；原行与旧搁置记录不变，新旁表保存退役原因和哈希。核对原文、任务和画像数据未变、retired数量及可执行队列为零后再启动服务。原文继续参与上下文，并在真实达到85%时进入新容量任务；不要把普通defer当作这次协议切换，否则会留下永久保留的原文缺口。

### schema22显式历史回填

先在本地完成验证，再停止PA服务，备份整个数据目录、配置、策略和服务单元。在新发布目录以pa用户打开数据库完成保留式迁移，核对原始消息、旧任务行及已有画像版本的哈希和外键；服务器无需重跑回归。按[记忆维护说明](memory.md#历史资料回填)执行plan、reserve和run，生产配置由原EnvironmentFile加载，不复制凭证到发布包。

群聊和私聊的回填顺序执行，避免共享人物/AI画像同时写入导致版本冲突。run只处理固定截止及任务范围，失败不能当作清空积压，保留输入、诊断与进度后明确处理；未经授权不自动重试收费调用。确认原文和旧版本保留、各run状态、剩余pending及压缩游标未变后启动服务；正常10/30分钟资料计时与85%压缩各自恢复。
