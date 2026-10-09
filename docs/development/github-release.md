# 自动构建与 GitHub Release

`.github/workflows/release.yml` 为 macOS Apple Silicon 比赛版提供签名、公证、有限包内检查和 GitHub Release 发布。它不替代[本轮产品验收](../acceptance/installer-20261009/RESULTS.md)中的冷机、真实 sbx、模型和原生交互结果。安装及本地打包见[比赛版安装说明](competition-installer.md)。

## 触发与版本

先在待发布的独立分支完成验证，再经授权创建匹配 `apps/desktop/package.json` 版本的 `v` 标签，例如版本 `0.1.1` 对应 `v0.1.1`。标签应指向已审查的精确提交，不要求合并 `main`。标签推送触发正式构建；Actions 的手动正式入口填写一个已经存在的版本标签，保持 `validate_only=false`，不创建或移动标签。`v0.1.0-rc.1` 这类标签对应同名 package version，发布为 prerelease。

手动选择分支并设置 `validate_only=true` 时，不需要 tag：工作流检出并核对该次事件的 `github.sha`，运行与正式发布相同的签名前门禁。此模式不导入凭据、不签名、公证、上传或发布，也不证明签名安装包检查通过。先核对验证 run 的 head SHA 和成功状态，再固定正式版本标签。

正式构建从该标签检出的干净提交运行；发布任务检出构建提交的 SHA，再检查远端标签仍指向同一提交。流程不会覆盖已发布 Release。工作流先创建 draft，上传并重新下载核对每项资产，全部成功后才公开发布。失败的 draft 仅在来源提交与整组文件散列完全一致时允许重试；应重跑原构建的失败发布任务，重新构建通常产生不同签名时间与散列，不能据此替换旧 draft。

## 必需配置

在 `JadeSnow7/web-studio-lab` 的 Settings → Secrets and variables → Actions 配置：

| 类型     | 名称                           | 内容                                                                                           |
| -------- | ------------------------------ | ---------------------------------------------------------------------------------------------- |
| Secret   | `MACOS_CERTIFICATE_P12_BASE64` | 人工提供的 Developer ID Application 证书与私钥 `.p12` 的 base64；不能用 Apple Development 证书 |
| Secret   | `MACOS_CERTIFICATE_PASSWORD`   | 该 `.p12` 的导出密码                                                                           |
| Secret   | `APPLE_ID`                     | 有公证权限的 Apple 账号                                                                        |
| Secret   | `APPLE_APP_SPECIFIC_PASSWORD`  | 该账号用于公证的专用密码                                                                       |
| Variable | `MACOS_SIGNING_IDENTITY`       | 完整证书身份，例如 `Developer ID Application: Aodong Hu (6429YPLDYU)`                          |
| Variable | `APPLE_TEAM_ID`                | Apple 团队 ID，此项目当前为 `6429YPLDYU`                                                       |

本地钥匙串里的 `wsl-notary` profile 不会自动出现在托管 runner；CI 用上表输入在临时钥匙串创建自己的 `wsl-release` profile。脚本不读取或导出现有宿主私钥，不把证书文件放进仓库或 Release。证书导入及公证命令失败只报告脱敏的工具名，不输出含密码的参数。任务最后恢复 runner 的钥匙串搜索列表并移除临时签名材料。

2026-10-09 正式发布准备时已确认上述四个 Secret 与两个 Variable 的名称存在；名称存在不证明凭据有效，签名和公证步骤仍须实际验证。不要在 issue、日志或聊天中粘贴这些 Secret 的值。

## 构建与发布门槛

构建使用 ARM64 `macos-15`、Node 24.21.0、pnpm 10.34.6 和固定 commit 的官方 Actions。runner 显式准备 ripgrep 并打印版本；安装锁文件依赖、生成并校验载荷后，用同一包内 Python 探测隔离标准库导入、SSL 与 PTY。真实本地终端生命周期和分离子进程测试均使用 `WSL_TEST_PYTHON`，启动失败只打印状态、时间与清理标记，不记录终端内容或环境。同一预探针还执行原始 PTY helper 与 zsh 集成的首次 start → ready → close → cleanup：5 秒 ready 截止、10 秒整体预算、失败不重试，单独记录耗时与清理结果。后续单测保留原等待预算；不能把预探针后的单测当作冷启动性能承诺。随后执行类型检查、离线单测、打包门禁测试、基线自检、当前应用及脚本的 lint 和文档链接检查。历史证据目录不进入这轮 lint。

正式 `pnpm package` 保持 `--publish never`，完成 Python 与 App 签名、App/DMG 公证、票据和 Gatekeeper 验证。Python 探针使用 `-I -B`，避免在签名包内写入 pyc；探针前后都检查 App 签名。随后运行安装配置、只读本地文件与本地 PTY 的有限 Electron smoke，再次检查签名。CI 不登录 Docker、不创建 sbx、不调用真实模型。

构建任务只有 `contents: read` 权限。验证后的文件作为工作流 artifact 交给独立发布任务，后者才取得 `contents: write`，使用内置 `GITHUB_TOKEN` 发布。源码指纹包括 `.github/` 与本说明；Release 的依赖、声明和清单从已验证 App 提取。

Release 资产扁平放置，包括 DMG、ZIP、`SHA256SUMS`、`release-manifest.json`、`release-assets.json`、安装说明、验收记录、依赖清单、来源清单、第三方声明和 LICENSE。下载到同一目录后，`shasum -a 256 -c SHA256SUMS` 可核对 DMG/ZIP；`release-assets.json` 记录所有交付附件的散列和大小。发布前对本地文件、上传返回的数据以及远端下载数据分别核对散列。

发布任务对远端标签的检查不自动移动标签。应保持版本标签不可变。若 Release 所指提交新增了相对默认分支的 workflow，GitHub REST 可能要求额外 `workflows: write`，内置 token 不具备该权限；这属于可能的远端权限阻塞，不能为了发布擅自合并 `main`、扩大 token 权限或引入 PAT；遇到拒绝应记录实际响应并请求处理。[GitHub Release API](https://docs.github.com/en/rest/releases/releases)

普通分支推送和 PR 不自动触发此发布工作流。2026-10-09 的 `v0.1.0` 发布运行 37897047313 在签名前单测门禁失败（505 通过、3 失败、15 跳过），未发布 Release；该标签保留不动。两个 rg 搜索失败与 runner 工具未准备一致，但原包装错误没有保存底层原因；首个 PTY 测试当时使用系统 Python 并停在 starting，冷启动根因尚未证明。`0.1.1` 补齐工具准备、统一测试运行时和有限诊断，仍保留原断言和等待预算，必须先通过上述非发布验证，再执行新的正式发布。云端结果及本机真实 sbx/模型验收分别记录，不能相互替代。
