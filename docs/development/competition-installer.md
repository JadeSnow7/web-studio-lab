# 比赛版安装与构建

比赛版面向 macOS 14 及更新版本的 Apple Silicon Mac。正式交付要求 Developer ID 签名、公证和干净机器验收；实现状态与证据以[本轮记录](../acceptance/installer-20261009/RESULTS.md)为准。未签名内部产物不能用于正式安装验收。

## 安装和首次启动

1. 打开正式 DMG，把 Web Studio Lab 拖到 Applications，再从 Finder 启动。保留系统下载隔离属性；如果 Gatekeeper 拒绝，记录错误并停止验收。
2. 在“设置 → 比赛环境安装”点击“检查安装条件”。应用检查系统、安装位置、随包载荷、代码签名和可用空间。
3. 点击“开始准备”。应用获取 Docker 官方 sbx 0.47.0，校验固定 SHA-256、供应商签名与版本，安装到 `~/Applications/Sbx.app`。兼容的已有安装可复用；冲突版本不会被覆盖。
4. 点击“打开 Docker 登录”，在系统终端完成官方登录。已有有效登录可以直接“继续准备”。
5. 应用登记唯一沙箱名称，创建不挂载宿主目录的 Codex 沙箱，关闭共享 skills，配置 2 CPU、4 GiB 内存。基础镜像固定到 digest，首次获取需要网络。
6. 应用复制随包 guest 载荷并核对散列，离线部署 Node 24.21.0、pnpm 10.34.6、Codex CLI 0.160.0，然后探测 Python、Git、CA 与 PTY。用户项目自己的第三方依赖需另行安装。
7. 没有模型凭据时，明确勾选全局 OAuth 作用范围后打开模型登录；已有凭据会保留。登录完成后继续准备。工具及凭据检查通过与真实模型调用通过是不同结果。
8. 按提示退出并重新打开应用。通过会话和终端验证真实模型读取同一沙箱中的文件。

用户无需安装 Homebrew、宿主 Node、pnpm 或 Python。宿主 Python 随 App 交付；sbx 不再分发在安装包中。首次网络准备仍依赖 Docker 官方下载、镜像服务与登录服务可用。

## 本地目录与 SSH

在设置中使用“选择本地目录”授权一个本地根目录，然后保存。未授权时，本地文件与本地终端明确不可用。目录选择器取消不会改变授权；清除授权后需保存。保存的环境设置在下次启动生效，当前运行会话继续使用原配置。

SSH 需要填写主机、端口、用户名、远程绝对目录和可信主机公钥的 SHA-256 十六进制指纹（64 位）。指纹须从受信任渠道取得，错误指纹必须拒绝连接。应用使用现有 SSH agent，不保存私钥；Finder 启动时没有可用 agent 或未加载相应密钥，会明确连接失败。

运行配置和安装阶段保存在 Electron 用户数据目录的 `runtime.json`。其中没有 Docker 或模型凭据；登录凭据交由 sbx 管理。正式包不读取 `WSL_*` 环境变量作为用户配置，开发及测试保留显式配置注入。

## 失败恢复与数据保留

安装失败时先阅读当前步骤和错误，再使用“重试安装”。沙箱名称在创建前保存，重试核对实际资源，避免创建第二个沙箱。中断的登录有独立操作记录；进程退出未确认时不会把安装或清理标为成功。不要手工删除记录来绕过错误。

已有不兼容 sbx、签名或载荷校验错误应先解决对应冲突，不能覆盖仍被其他任务使用的安装。应用退出只清理自身拥有的进程，不停止其他沙箱、不删除沙箱文件；重新安装保留用户数据。本轮没有自动更新或全局卸载清理功能。

## 构建与交付

在 macOS ARM64 构建机使用固定 pnpm 10.34.6，先安装锁文件依赖，再制作载荷：

```bash
npx --yes pnpm@10.34.6 install --frozen-lockfile
npx --yes pnpm@10.34.6 payloads:prepare
npx --yes pnpm@10.34.6 test:packaging
```

`packaging/dependencies.lock.json` 固定来源、版本、平台、散列、探针和许可证。制作过程从公开固定源获取完整 guest 工具树，不导出个人沙箱；输出位于忽略跟踪的 `packaging/generated/runtime/`。可用空间阈值包含展开体积与预留量，目前是估算值，需用冷机峰值实测校准。

正式证书及私钥应已安装在构建机钥匙串。优先使用已配置的 notarytool 钥匙串 profile，以下只展示名称，不填写或提交密码：

```bash
export CSC_NAME='Developer ID Application: Your Name (TEAMID)'
export APPLE_KEYCHAIN='/absolute/path/to/login.keychain-db'
export APPLE_KEYCHAIN_PROFILE='your-existing-notary-profile'
npx --yes pnpm@10.34.6 package
```

构建也接受 electron-builder 支持的完整 Apple API 凭据或 Apple ID 公证变量；均只从受保护构建环境读取。Apple Development 证书不满足正式交付要求。

流水线构建 service 和 Electron，核对 service 外置依赖，签署内置 Python 的 Mach-O 文件并更新载荷散列，然后由 electron-builder 签署 App、启用 Hardened Runtime、公证，生成 DMG/ZIP。DMG 另行公证与装订票据；`codesign`、`spctl`、`stapler` 检查成功后才输出正式清单。打包命令使用 `--publish never`；GitHub 自动发布在独立步骤校验产物后上传，配置见 [GitHub Release 流程](github-release.md)。

宿主 Python 的应用启动入口同时使用 `-I` 和 `-B`：前者隔离用户 Python 环境，后者禁止更新 App 内的字节码缓存，避免运行后破坏资源签名。两者作用不同，不能只设置环境变量替代。[Python 命令行说明](https://docs.python.org/3/using/cmdline.html#cmdoption-B)

正式产物位于 `apps/desktop/release/`，清单位于其 `artifacts/`：包含 `SHA256SUMS`、`release-manifest.json`。随包 `Contents/Resources/runtime/` 含依赖及来源清单、第三方声明和许可证。发布前还需随交付资产提供本中文说明和本轮验收记录。

```bash
npx --yes pnpm@10.34.6 package:unsigned
WSL_E2E_TARGET=packaged \
WSL_E2E_APP_PATH="$PWD/apps/desktop/release-internal/mac-arm64/Web Studio Lab.app" \
npx --yes pnpm@10.34.6 exec playwright test
```

上面只生成和验证内部未签名包。包内测试使用隔离的用户配置；不能替代没有开发工具、没有 sbx 的新 Mac 从 Finder 启动与安装验收。正式结果还要求受控真实 SSH/SFTP、真实模型 nonce、中文输入及原生窗口补验，详见[验收约定](../acceptance/installer-20261009/SPEC.md)。
