# 开发依赖与安装

桌面对话和交互终端通过 sbx 使用同一个 Linux guest 工作目录。host 需要 Node/pnpm 构建应用和 sbx CLI；guest 需要 Python 3、Codex CLI 及项目工具。独立环境准备记录见[sbx 安装验证](../verification/2026-10-06-sbx/README.md)，应用接入记录见[应用验证](../verification/2026-10-06-sbx-app/README.md)。

## 桌面项目

| 依赖                                                    | 版本与用途                                                                           | 当前证据边界                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| macOS                                                   | macOS 14+，Apple Silicon / arm64                                                     | 现有桌面验证平台；其他平台未验证                         |
| Node.js                                                 | 建议 Node 24，与 `.nvmrc` 和 Electron 内置 Node 主版本对齐；根 `engines` 允许 `>=24` | 本轮系统检查实际使用 Node 26.5.0；Node 24 组合待单独验证 |
| pnpm                                                    | `10.34.6`，由根 `package.json` 固定                                                  | 安装和检查使用此版本                                     |
| Electron、React、TypeScript、Zod、Vitest、Playwright 等 | 精确版本由各 `package.json` 与 `pnpm-lock.yaml` 管理                                 | 不单独全局安装这些项目依赖                               |
| Codex CLI                                               | 安装在 guest 中，使用 sbx 宿主 OAuth 代理与 CLI 默认模型                             | 连接检查与真实模型回复分别验证；见对话 SPEC 与验证记录   |

### 从零准备 host 工具

以下命令面向已安装 Homebrew 的 Apple Silicon macOS；当前 host 已有 Homebrew。`/opt/homebrew/bin` 必须存在、当前用户可写并在 PATH 中。先确认 host 前置条件：

```bash
command -v brew
test -d /opt/homebrew/bin
test -w /opt/homebrew/bin
export PATH="/opt/homebrew/bin:$PATH"
brew install node@24
export PATH="$(brew --prefix node@24)/bin:$PATH"
node --version
npm --version
npx pnpm@10.34.6 --version
```

确认 `node --version` 为 24.x，pnpm 为 10.34.6。上面的 PATH 仅作用于当前 shell；新终端需重新设置，或由用户将相同 PATH 配置加入自己的 shell 配置。若已有其他 Node 版本，先确认 PATH 的实际解析结果，不据包已安装推断当前正在使用该版本。

应用当前不要求 host 安装 Codex。guest 使用 OpenAI 官方 `@openai/codex@0.160.0`；安装脚本与 sbx OAuth 步骤见下文。此前 host Codex 对话验证保留在历史记录，不代表当前执行路径。

### 安装并检查项目

从仓库根目录安装，保留固定锁文件。无全局 pnpm 时直接使用固定版本入口：

```bash
npx pnpm@10.34.6 install --frozen-lockfile
npx pnpm@10.34.6 check
npx pnpm@10.34.6 build
WSL_SBX_NAME=wsl-sbx-smoke-20261006 npx pnpm@10.34.6 dev
```

已有全局 pnpm 且版本为 10.34.6 时，可将上面命令中的 `npx pnpm@10.34.6` 替换为 `pnpm`。首次安装及 Electron 二进制下载需要网络；不要改锁文件或升级依赖来绕过安装失败。原始错误与实际使用的 Node/pnpm 版本应随验证记录保存。

## 独立沙箱工具 sbx

`sbx` 是桌面对话和终端所需的宿主工具，独立安装，不加入 pnpm workspace 或 npm 锁文件。xterm.js 6.0.0 和 fit addon 0.11.0 由桌面 package 与锁文件管理；PTY 由 guest Python 标准库实现，无需安装 host node-pty。

2026-10-06 已通过 [Docker 官方 v0.47.0 发布归档](https://github.com/docker/sbx-releases/releases/download/v0.47.0/DockerSandboxes-darwin.tar.gz) 在本机安装。实际路径为 `/Users/huaodong/Applications/Sbx.app`，`/opt/homebrew/bin/sbx` 链接到 app 内 CLI。实际命令是 `sbx version`，不是 `sbx --version`；后者在本版本返回 unknown flag。

- 版本：`v0.47.0 0411f50ee4700fe7bd37e6e7e3aced563e850ca9`。
- 归档 SHA256：`947e68826c62b12de2fa0ba5b0a67a953911a2321203c04f7c0982ccfc0f1694`。
- `codesign --verify --deep --strict` 在真实 host 上通过；工具自身的受限沙箱曾报告 invalid signature，该结果单独保留，不替代真实 host 的检查。

以下命令复现该安装路径，要求目标 app 与 CLI 链接尚不存在；现有安装不覆盖。归档地址与指纹固定，不自动跟随 latest：

```bash
(
  set -eu
  sbx_install_dir=$(mktemp -d)
  trap 'rm -rf "$sbx_install_dir"' EXIT
  test ! -e "$HOME/Applications/Sbx.app"
  test ! -L "$HOME/Applications/Sbx.app"
  test -d /opt/homebrew/bin
  test -w /opt/homebrew/bin
  export PATH="/opt/homebrew/bin:$PATH"
  test ! -e /opt/homebrew/bin/sbx
  test ! -L /opt/homebrew/bin/sbx
  curl --fail --location \
    https://github.com/docker/sbx-releases/releases/download/v0.47.0/DockerSandboxes-darwin.tar.gz \
    --output "$sbx_install_dir/DockerSandboxes-darwin.tar.gz"
  printf '%s  %s\n' \
    947e68826c62b12de2fa0ba5b0a67a953911a2321203c04f7c0982ccfc0f1694 \
    "$sbx_install_dir/DockerSandboxes-darwin.tar.gz" | shasum -a 256 -c -
  tar -xzf "$sbx_install_dir/DockerSandboxes-darwin.tar.gz" -C "$sbx_install_dir"
  codesign --verify --deep --strict "$sbx_install_dir/Sbx.app"
  mkdir -p "$HOME/Applications"
  ditto "$sbx_install_dir/Sbx.app" "$HOME/Applications/Sbx.app"
  ln -s "$HOME/Applications/Sbx.app/Contents/MacOS/sbx" /opt/homebrew/bin/sbx
  sbx version
  sbx --help
)
```

Homebrew tap 是另一条可选安装路线：`brew trust docker/tap` 会持久信任该第三方 tap，再由 `brew install docker/tap/sbx` 安装。本轮自动审批拒绝了持久增加 tap 信任，实际采用上面的官方归档路线，没有更改 tap 信任。

已读取本机 v0.47.0 帮助：`create` 省略 PATH 可创建不挂载 workspace 的沙箱，`--skills off` 关闭共享 skills；`exec` 支持 `-i`（传 stdin）与 `-w`（guest 工作目录），无需分配 TTY。以下命令从仓库根目录执行，使用新的唯一沙箱名与 guest 绝对路径。

### 完成 host 认证

2026-10-06 Docker OAuth 已由用户完成；OpenAI OAuth 当前仅支持 global 保存，已在用户明确授权系统钥匙串保存后，通过 `sbx secret set openai --oauth` 成功完成（退出码 0）。从零登录需要用户完成浏览器流程；`sbx login` 涉及服务协议接受，由用户本人确认：

```bash
sbx login
sbx secret set openai --oauth
```

文档与脚本不读取、复制或打印认证文件、访问令牌或模型密钥。登录是模型执行的前置条件，读取验证器本身不检查认证状态；模型启动或执行失败会保留证据并失败退出。

### 检查设置并创建独立沙箱

仅用 `env -u SSH_AUTH_SOCK` 清除 host 环境变量，不会关闭 sbx 配置的 SSH agent 转发。下面的设置作用于整个本机 sbx，不限于单个沙箱，需重启 daemon 后生效。已有运行中的沙箱须先明确选择并停止；不要批量停止其他工作。新安装、尚未创建沙箱时，可按此顺序执行：

```bash
sbx policy ls
sbx settings set ssh.agentForwardingEnabled false
sbx daemon restart
sbx_smoke_name="wsl-sbx-smoke-$(date +%Y%m%d-%H%M%S)-$$"
sbx_probe_dir="/tmp/wsl-read-test-$(date +%Y%m%d-%H%M%S)-$$"
env -u SSH_AUTH_SOCK sbx create --name "$sbx_smoke_name" --skills off --cpus 2 --memory 4g codex
sbx inspect --json "$sbx_smoke_name"
```

同一个 shell 保留这两个变量供后续命令使用；重新打开终端时，需要显式填回自己的沙箱名和 probe 路径。本轮实际沙箱为 `wsl-sbx-smoke-20261006`，不挂载 host workspace，skills off，Linux aarch64。实际是在创建后执行 `sbx stop wsl-sbx-smoke-20261006` 再重启 daemon；重启后 `SSH_AUTH_SOCK` 环境变量仍存在，但其指向的 socket 文件已不存在。重启前 `ssh-add` 的 communication failed 不能证明转发禁用。

本机为新安装的 deny-all 网络基线，默认 Agent kit 已允许 npm/OpenAI/GitHub 及 apt 域名。已有机器应先通过 `sbx policy ls` 核查自己的策略，不用 `policy init` 覆盖现有全局设置。下载 Node 额外需要当前沙箱的 `nodejs.org:443` 规则：

```bash
sbx policy allow network --sandbox "$sbx_smoke_name" nodejs.org:443
```

### 准备 guest 工具

本轮模板已包含 Codex 0.149.1、Node 22.22.1、npm 9.2.0、Git 2.53.0、Python 3.14.4；未包含 pnpm 和 xz。模板 digest 为 `sha256:8b4cd0a46c8b600bc6b6a64af23c03d4c2807fbfc61f47568092a93fb9dc88b0`。模板已自带 Codex，无需为了运行模型重复安装；本次升级是为对齐已测的 CLI 与项目工具版本。

[guest 准备脚本](../../scripts/sbx-prepare-guest.sh) 只安装工具，不调用模型、不读取认证、不修改网络策略。它下载官方 Node 24.21.0 Linux arm64 `.tar.gz`，校验固定 SHA256 `724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5` 后解包到 `/usr/local`；npm 全局前缀保持 `/usr/local/share/npm-global`，安装 Codex 0.160.0 与 pnpm 10.34.6。脚本使用非交互 sudo，任何权限、下载、指纹或版本检查失败都会退出。

```bash
env -u SSH_AUTH_SOCK sbx exec -i "$sbx_smoke_name" bash < scripts/sbx-prepare-guest.sh
```

本轮准备命令已在 guest 实际运行，退出码 0：Node 24.21.0、npm 11.19.0、Codex 0.160.0、pnpm 10.34.6；Git 2.53.0 与 Python 3.14.4 保持模板版本。准备脚本的 PATH 只作用于其当前进程，后续 exec 显式设置工具 PATH，避免依赖旧 exec 的环境。

### 显式运行一次模型读取

[模型读取验证器](../../scripts/sbx-read-smoke.py) 仅在 Linux guest 中运行。下面命令调用真实模型；probe 必须为新的 guest 绝对目录，重复使用已有目录会直接报错。默认准备步骤不会运行这个测试。

```bash
env -u SSH_AUTH_SOCK sbx exec -i \
  -e PATH=/usr/local/bin:/usr/local/share/npm-global/bin:/usr/bin:/bin \
  "$sbx_smoke_name" python3 - "$sbx_probe_dir" \
  < scripts/sbx-read-smoke.py
```

验证器在 guest 写入 256-bit 随机 nonce，保存普通 `cat` 读取结果；给 Codex 的提示只包含文件绝对路径和读取要求，不包含 nonce。模型进程 stdin 为 `/dev/null`，防止管道中的脚本内容进入提示。保留 `nonce.txt`、`shell-read.txt`、`prompt.txt`、`codex.jsonl`、`codex.stderr`、`exit-code.txt` 与 `summary.json`。同时要求已完成的 `command_execution` 真实读取目标文件、命令退出码 0 且输出吻合、助手回复逐字吻合、`turn.completed` 与模型进程退出码 0；只返回正确文本不足以通过。180 秒超时会清理所属模型进程并失败，证据保留。

本轮首次真实执行已通过：probe 为 `/tmp/wsl-read-test-20261006-a`，原始 JSONL 包含 `cat` 读取该绝对路径下的 `nonce.txt`、成功命令退出、匹配的输出与助手回复，以及 `turn.completed`；`summary.json` 全部通过，模型进程退出码 0。实际调用未额外设置 PATH，但该次 guest 版本检查正确；上面的复现命令显式设置 PATH。

模板配置出现两次警告：Codex 0.160.0 忽略 `mcp_servers.mcp-gateway.headers/type`。警告未阻止此次文件读取；MCP gateway 能力未验证，也未修改供应商配置。脚本不覆写模板认证/provider，不登录、不处理 host canary、不操作 host 沙箱。

### 导出证据并停止

证据导出到新的 host 目录，避免混入旧结果；`sbx cp` 的源目录会成为目标目录，目标已存在时则复制到其内部。下面先保证目标不存在，再导出，最后停止本次创建的沙箱并检查状态：

```bash
sbx_evidence_dir=".local/sbx-verification/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$sbx_evidence_dir"
test ! -e "$sbx_evidence_dir/probe"
test ! -L "$sbx_evidence_dir/probe"
sbx cp "$sbx_smoke_name:$sbx_probe_dir" "$sbx_evidence_dir/probe"
sbx stop "$sbx_smoke_name"
sbx inspect --json "$sbx_smoke_name"
```

本轮已导出 `.local/sbx-verification/2026-10-06/probe-a`，导出内容逐字核验及 SHA256 检查通过；最终 `inspect` 确认沙箱状态为 `stopped`、0 sessions。原始结果见[验证记录](../verification/2026-10-06-sbx/README.md)。

独立 smoke 成功证明该次沙箱内 Codex 读取内部文件的通路成立。它不等于 Electron 聊天经由 sbx 运行，也不等于任务执行、Browser 工具、自动改码或固定验收已集成。host 项目未挂载及 host canary 的独立检查见验证记录；随机文件与模型读取证据只证明本次受控 smoke。

## 启动已接入 sbx 的 Web Studio

复用本机已准备好的 sandbox：

```bash
WSL_SBX_NAME=wsl-sbx-smoke-20261006 npx pnpm@10.34.6 dev
```

新建环境则将名称改为前述 `$sbx_smoke_name`。`WSL_SBX_BIN` 可显式指定 sbx；默认查 PATH 与常见安装位置。选择的 sandbox 必须为 Codex agent 且没有运行时挂载。配置缺失或目标不符时，应用报告不可用；它不会自动创建环境或运行 host Codex。

打开空间的“终端”标签并点击“连接终端”；终端与聊天都使用 `/home/agent/workspace`。从终端创建文件后，在聊天中提供 guest 路径即可让 Codex 使用工具读取。终端输出保留最近 256 Ki 字符；Codex 工具结果有界且截断会标明。关闭终端或窗口会清理应用登记的 guest 进程，不删除文件或停止整个 sandbox。直接双击未设置启动环境的应用不会自动知道应使用哪个 sandbox。

显式集成验证：

```bash
npx pnpm@10.34.6 build
WSL_LIVE_SBX=1 WSL_SBX_NAME=wsl-sbx-smoke-20261006 npx pnpm@10.34.6 exec vitest run apps/service/src/sbx.live.test.ts
WSL_LIVE_SBX=1 WSL_SBX_NAME=wsl-sbx-smoke-20261006 npx pnpm@10.34.6 exec playwright test e2e/sbx.spec.ts --grep live
```

第一条 live 检查仅验证真实 guest 进程/PTY 清理，不调用模型；第二条通过 Electron 终端与聊天调用真实模型。普通测试默认跳过这两项外部依赖检查。具体结果和未验证范围以应用验证记录为准。

## 公开网页空间资源

2026-10-06 用户明确授权的资源扩展使用 parse5 8.0.1（entities 8.1.0）在 main 解析 HTML；版本由锁文件固定，许可见根目录 THIRD-PARTY-NOTICES.md。公开网页为真实 HTTPS 响应的只读标题与正文表示，不执行原站脚本或加载原站子资源。

在 Browser 地址栏打开公开 HTTPS 页面，加载完成后点击“加入空间”。资源页提供保存快照的来源、标题、正文、资源身份和版本；更新绑定当前同 URL 页面，删除后下一轮资源包不再包含该资源。原始用户数据目录内的 chat/space-resources.json 是本机持久记录，测试必须使用独立 user-data-dir，不能污染现有用户资源。

当前 taskflow-demo 空间只映射到对应空间会话，个人会话不枚举空间资源。资源进入 Agent 前冻结为每轮快照；Linux Python 必须支持 os.memfd_create 和 F_SEAL_WRITE/GROW/SHRINK/SEAL。有限 stdio MCP 通过本次 Codex 的 -c 参数启动，不修改 guest 持久 MCP 配置，不创建 host mount 或读取凭据。已保存的公共文档作为非可信资料返回，不能改变工具权限；共享 guest 并不提供 OS 级会话文件保密。

运行中的资源回复禁止更新/删除；完成清理后可变更，下轮读取新版本。界面历史中的既有引用不会被删除或改写。既有终端文件 smoke 只验证 guest 文件读取，不代表空间资源 MCP 已通过；本轮合同和结果见 [公开资源验证](../verification/2026-10-06-public-resources/SPEC.md)。

系统 DNS 如返回 private、loopback 或保留地址，公开导航会失败并给出错误。不得为使测试通过而放行这些范围或关闭 TLS 校验；这类环境问题与产品回归分别记录。
