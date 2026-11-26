# PA 的 CI 与持续交付

GitHub Actions 在 PR 上检查变更，`main` 通过全量回归后生成按提交号命名的交付包。生产服务器的切换、备份和回退由现有发布流程管理。[工作流](../.github/workflows/ci.yml) · [服务器部署](deployment.md)

| 事件 | 会运行什么 | 在哪里看结果 |
|---|---|---|
| 新建、重新打开、推送 PR，或更换目标分支 | 校验中文说明，在 GitHub 生成的合并版本上编译并执行受影响回归。堆叠 PR 按自己的目标分支计算差异。 | PR 的 Checks，查看「PR 标题与说明」和「代码检查」。 |
| 仅修改 PR 标题或正文 | 重新检查中文说明。上一次代码验收仍对应原代码提交。 | PR 的 Checks，进入中文说明检查查看缺失的小节。 |
| 推送到 `main`，或在 Actions 手动选择 `main` 运行 CI | 安装锁定依赖、编译、运行全部离线回归，然后生成并上传交付包。前面任一步失败就停止交付。 | Actions → CI → 对应提交的运行记录 → Artifacts。 |

### CI 怎样选测试

CI 使用 Ubuntu 24.04 和 Node.js 24.15.0。依赖版本及完整性校验取自 `package-lock.json`。PR 的变更文件来自目标分支与 PR 源提交的共同起点；[选取脚本](../scripts/ci/check-pr.mjs)将源码和测试交给仓库原有的 [repo-check](../scripts/repo-check.mjs)。仅文档变更执行编译；共享测试辅助文件、未知源码、删除源码、依赖、工作流及构建脚本变更走全量。只改一个已知业务模块时看该模块关联的回归。具体运行了哪些文件，以 CI 日志为准。

本地可在待验收的合并结果或相应 checkout 上复查，传入实际 PR 的目标提交和源提交：

```text
node scripts/ci/check-pr.mjs <base-sha> <head-sha>
node scripts/repo-check.mjs all
```

验收采用隔离的临时数据和本地替身。工作流只申请仓库读取权限，PR 检查不需要 PA 的模型、QQ 或服务器凭据。「代码检查」通过表示所列范围通过；是否强制合并前通过取决于仓库分支保护设置。

### 怎样领取交付包

从对应 `main` 工作流下载 `pa-<完整提交号>`，解开 GitHub 提供的外层压缩文件，里面有 `pa-<完整提交号>.tar.gz` 和 `SHA256SUMS`。在 Linux 下载目录执行：

```bash
sha256sum -c SHA256SUMS
read -r -p '请输入 Actions 运行的完整提交号：' sha
tar -tzf "pa-${sha}.tar.gz"
tar -xOzf "pa-${sha}.tar.gz" RELEASE_SHA
```

`sha` 取该次 Actions 运行的完整提交号。验收时核对校验和通过、包内 `RELEASE_SHA` 与运行提交一致。交付包包含该提交的源码、锁文件、维护脚本、测试及重新编译的 `dist/`。运行依赖按包内锁文件安装，`node_modules`、真实环境配置和业务数据由目标环境管理。Actions 中的交付物请求保留 14 天，实际期限受仓库设置约束。

同一流程也能在本地复核。准备好锁定依赖，在已提交且跟踪文件干净的 checkout 运行 `node scripts/ci/package-release.mjs <新输出目录>`。本地打包命令本身不代表回归通过，应与对应提交的检查结果一起使用。[打包脚本](../scripts/ci/package-release.mjs)

在新的暂存目录解包后，如需与 CI 使用同一个依赖源，可运行 `npm ci --registry=https://registry.npmjs.org/ --replace-registry-host=registry.npmmirror.com --no-audit --no-fund`。该命令沿用包内锁定版本和完整性校验，运行时依赖安装在暂存目录。

### 怎样判断是否已上线

Actions 中有交付包，表示这版可以交给部署人员。确认线上版本时，应核对服务器的 `/opt/pa/current`、PA 服务进程及 QQ 就绪状态。需要切换时，沿用仓库里的存储锁、停服务备份、切换、就绪检查与回退约定。本工作流不持有 SSH 凭证，不会因合并 PR 自动重启机器人。[部署与回退](deployment.md) · [只读巡检](operations.md)
