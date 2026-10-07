# sbx 安装与真实 Codex 读取验证

2026-10-06，独立沙箱验证通过。官方 sbx 已安装，沙箱内已准备 Node 24、pnpm 与 Codex CLI；真实 Codex 通过工具读取了仅在 guest 中生成的随机内容并准确回复。沙箱现已停止，内部组件和文件保留。Web Studio 当前聊天仍使用 host Codex，本轮未接入产品执行通路。

## 环境与复现入口

- 安装与逐步命令：[开发依赖](../../development/dependencies.md)。脚本：[准备组件](../../../scripts/sbx-prepare-guest.sh)、[真实读取](../../../scripts/sbx-read-smoke.py)。
- 固定基准：[SPEC](SPEC.md)。本轮沿用该基准，没有以普通 shell 成功替代模型执行。
- host：macOS 26.6.2 / arm64；sbx `v0.47.0`，commit `0411f50ee4700fe7bd37e6e7e3aced563e850ca9`。
- 安装位置：`/Users/huaodong/Applications/Sbx.app`；CLI：`/opt/homebrew/bin/sbx`。
- sandbox：`wsl-sbx-smoke-20261006`，2 CPU / 4 GiB，Linux aarch64；未传宿主 PATH，`--skills off`。
- 模板：`docker/sandbox-templates:codex-docker`，digest `sha256:8b4cd0a46c8b600bc6b6a64af23c03d4c2807fbfc61f47568092a93fb9dc88b0`。

## 结果与证据

| 基准   | 结果             | 实际证据                                                                                                                                                                                                           |
| ------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SBX-01 | 通过             | 固定官方归档 SHA256 匹配，真实 host 上 `codesign --verify --deep --strict` 通过；`sbx version`、帮助命令成功。见 [安装记录](evidence/installation.json)。                                                          |
| SBX-02 | 通过             | [创建后 inspect](evidence/inspect-created.json) 和 [模型执行前 inspect](evidence/inspect-pre-model.json) 均为 `runtime_mounts: []`；实际 [mount 清单](evidence/isolation-check.txt) 无宿主项目或 HOME。            |
| SBX-03 | 通过             | guest 安装脚本退出 0；最终 Node 24.21.0、npm 11.19.0、Codex 0.160.0、pnpm 10.34.6、Git 2.53.0、Python 3.14.4。见 [版本输出](evidence/guest-versions.txt)。                                                         |
| SBX-04 | 通过             | guest 新建 256-bit nonce，普通 `cat` 输出匹配；无敏感宿主 canary 以其宿主绝对路径读取失败，返回不存在。见 [普通读取](evidence/probe-a/shell-read.txt) 和 [隔离检查](evidence/isolation-check.txt)。                |
| SBX-05 | 通过，有配置警告 | [提示](evidence/probe-a/prompt.txt) 只给路径，不含 nonce；[JSONL](evidence/probe-a/codex.jsonl) 记录真实 `cat`、工具退出 0、助手准确回复、`turn.completed`；CLI 退出 0。见 [判定](evidence/probe-a/summary.json)。 |
| SBX-06 | 通过             | `sbx cp` 导出后重新比较文件、工具输出和回复，保存 [SHA256](evidence/probe-export-verified.json)；`sbx stop` 后 [inspect](evidence/inspect-stopped.json) 确认为 `stopped`、0 sessions。                             |

模板初始为 Codex 0.149.1 / Node 22.22.1 / npm 9.2.0，无 pnpm。准备脚本从 Node 官方下载固定 arm64 归档并验 SHA256，再固定安装 Codex 0.160.0 与 pnpm 10.34.6；没有依据 host 版本推断 guest 版本。

模型测试目录为 `/tmp/wsl-read-test-20261006-a`。Codex 使用 `--sandbox read-only`，保留模板的认证与 provider 配置。模型提示和 stdin 均未包含 nonce；stdin 显式为 DEVNULL。原始事件显示唯一读取命令为：

```text
/bin/bash -lc 'cat /tmp/wsl-read-test-20261006-a/nonce.txt'
```

本轮真实读取首次运行即通过。验证器另经[本地 fixture 检查](evidence/verifier-fixtures.txt)：完整事件通过；仅正确回复、没有工具读取时失败；坏 JSON 失败并保留 summary；错误目录下同名文件也判失败。审阅后将脚本的目标匹配收紧为完整路径，保存的真实 JSONL 符合此条件，未重复调用模型。脚本语法检查通过。未重跑 Electron 全套测试，因为本轮没有修改应用源代码。

## 认证、网络和隔离边界

Docker 登录和 OpenAI OAuth 均已成功。当前 sbx 的 OpenAI OAuth 仅支持 global scope；用户明确授权将其保存到 Docker Sandboxes 宿主凭据存储 / 系统钥匙串，后续 sbx 沙箱也能经代理使用这项授权。本轮未读取或复制 host Codex 认证文件；登录原始日志留在忽略目录，不进入仓库证据。

这台新装 sbx 的网络初始设为 deny-all，Codex Agent kit 随后提供 OpenAI、npm、GitHub、apt 等域名规则。本轮只新增此沙箱的 `nodejs.org:443` 规则，见 [最终生效策略](evidence/policy-final.json)。已有机器应检查自己的策略，不能从本记录推断其默认拒绝所有其他网络。

已将本机 sbx 的全局 `ssh.agentForwardingEnabled` 设为 `false` 并重启 daemon。仅清除 host 的 `SSH_AUTH_SOCK` 不足以移除 guest 代理入口；重启后 guest 仍有该环境变量，但其 socket 文件已不存在。[版本输出](evidence/guest-versions.txt) 同时记录了这一事实。

`inspect` 显示 MCP gateway 仍启用；本轮创建前没有注册的 MCP 服务。新版 Codex 报告模板的 `mcp_servers.mcp-gateway.headers` 和 `.type` 不识别，警告在 JSONL 重复出现两次。该警告未阻止文件读取，但本轮不对 MCP gateway 调用能力作通过判定，也未擅自改写模板配置。

mountless、一个宿主 canary 不可达和一次 read-only 模型执行，只证明本次实验的具体通路；未验证恶意代码对抗、完整宿主隔离、多租户安全、Browser/网络工具、项目构建或 Web Studio 沙箱集成。

## 保留的异常与工作区边界

- 自动审批拒绝 `brew trust docker/tap` 的持久信任扩展。改用已验 SHA256 与签名的官方归档安装，未修改 tap 信任。
- OpenAI OAuth 首次被自动审批要求明确凭据目的地；用户明确批准 global scope / 系统钥匙串后执行成功。
- 初次 `sbx login` 在供应商系统代理代码中出现 `fatal error: concurrent map writes`；重新启动登录流程后成功。中途过期或已使用的设备码没有重用。
- `sbx --version` 不受此版本支持，正确命令是 `sbx version`。受限工具环境的签名检查曾报 invalid signature，同一检查在真实 host 通过；没有关闭 Gatekeeper 或跳过签名检查。
- 镜像准备阶段出现一次 Docker Hub refresh lock 超时提示；后续镜像创建成功，未将中间提示当作成功证据。

基线指纹复验：原有 242 个文件中仅 README.md 和 .prettierignore 改变，无文件缺失；见 [基线比较](evidence/baseline-comparison.json)。原始安装、登录和准备日志及基线文件指纹保存在忽略目录 `.local/sbx-verification/2026-10-06/`；可分享的脱敏测试数据保存在本目录 `evidence/`。仓库原有未提交内容保留；本轮仅增加依赖说明、两个沙箱脚本与验证记录，修改 README 入口，并将封存证据排除在格式化之外，未提交或推送。
