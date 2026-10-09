# 比赛安装器实现与验收记录

安装器源码、固定离线载荷和正式打包门禁已实现，真实沙箱离线部署及失败恢复通过。2026-10-09 已确认有效 Developer ID Application 签名身份及 `wsl-notary` 公证配置，最终 App/DMG 已完成签名、公证与票据检查，产物散列及最终包五项 smoke 结果见 [SIGNED-RESULTS.md](SIGNED-RESULTS.md)。干净机器安装、保留 quarantine 的 Gatekeeper 验收仍不能由本机开发环境替代。

## 源码与范围

独立工作树基于 `3e631a9e387190da5a2241945bbf7e14edbd5707`，分支 `codex/competition-installer`。原工作目录未提交内容保留。实现与 CI 通过该独立分支交付；本轮不合并 main、不打版本标签、不发布 GitHub Release。基线与锁文件散列见 [baseline.json](baseline.json)，验收项见 [SPEC.md](SPEC.md)。

Main 单点保存运行配置、安装阶段和登录操作身份；service 接收显式 sbx、沙箱、Python、本地根和 SSH 配置。正式包不靠 `WSL_*` 配置启动。本地 Python 使用隔离模式；新机器不需要 Homebrew、宿主 Node、pnpm 或 Python。

安装设置已接入原生目录授权、SSH 指纹校验、全局模型 OAuth 确认、阶段展示、取消、重试和重启生效提示。准备流程固定 sbx 0.47.0、基础镜像 digest、唯一 mountless 沙箱和随包 guest 工具；凭据存在与真实模型验证分开。

范围保留 main 既有功能，不新增 C1–C3、独立业务检查器、guest 服务预览或未接入的 guest 浏览器切片。

## 检查记录

本机 Node 为 26.5.0，使用缓存的固定 pnpm 10.34.6；未据此声明 Node 24 构建环境验收。首次受限执行有 socket、文件监听权限失败；随后在允许本机权限的环境中重跑，原失败证据没有作为产品通过依据。

内部包阶段类型检查通过，单元测试 449 passed / 8 skipped（64 个测试文件通过、4 个显式跳过），当时打包检查 13 passed。PTY 专项实际使用随包 Python，验证恶意当前目录和 PYTHONPATH 不能替换标准库导入。安装 UI 两项检查覆盖错误恢复、目录授权、SSH 校验、持久化和重启；修改范围 ESLint 通过。随后 Python 签名修复后的完整单元回归为 451 passed / 8 skipped（65 个测试文件通过、4 个显式跳过），类型检查通过，日志为 `unit-python-seal.log` 与 `typecheck-python-seal.log`。

内部 DMG/ZIP 构建通过，包内 Python、载荷散列与 service SSH/SFTP 外置依赖审计通过。固定依赖版本、归档散列和内部产物 SHA-256 见 [internal-artifacts.json](internal-artifacts.json)。完整包内 E2E 为 62 passed / 2 skipped，耗时约 4 分钟；两项跳过为既有 build 专用注入检查，并非本轮删减。5 项显式 live 全部通过：中文续聊、网页/文件/终端三来源观察、真实公开网页 MCP 读取、终端未知 nonce 与 Codex 同沙箱读取、跨空间 PTY/模型归属。真实 SSH agent 认证、SFTP、PTY 和错误指纹拒绝也通过（受控 loopback SSH 服务器）。

完整 E2E 的产物散列另存 [live-validated-artifacts.json](live-validated-artifacts.json)。之后仅修复了目录选择器关闭后的 renderer 焦点恢复；最终包另跑安装 UI 定向基线 2/2 passed，并在真实 NSOpenPanel 取消后确认焦点回到“选择本地目录”按钮。后端和 guest 载荷未改变。各次失败与恢复记录保留在本目录本机日志中，没有把失败轮次记作通过。

全树 lint 和格式检查保留历史问题：本次全树 lint 报 1972 项，Prettier 报 727 个文件，涉及封存来源树、基线及既有格式。新增改动采用定向检查，不自动重写历史档案。严格 UI 静态审计为 0 errors / 0 warnings，见 [ui-audit.json](ui-audit.json)；静态检查不替代原生操作。

## 正式交付条件

正式入口 `pnpm package` 要求 Developer ID Application、公证凭据、固定载荷和中文交付文档。签署内置 Python 后签署 App，执行公证与票据装订；任何一步失败都不会生成成功发行清单。内部未签名产物位于 `apps/desktop/release-internal/`，与正式 `release/` 分开。

此前单独导入 `.cer` 及首份 `.p12` 后仍未获得有效 Developer ID 身份，正式入口按预期拒绝。用户随后完成配置，2026-10-09 实测 `security find-identity -v -p codesigning` 已包含 `Developer ID Application: Aodong Hu (6429YPLDYU)`，SHA-1 为 `694183FC7305489F75A2E06D4AECDA4A5CE1DEF4`；`notarytool` 使用登录钥匙串中的 `wsl-notary` 成功认证。没有导出私钥或修改其访问权限。

签名、公证、DMG 及 App 的 Gatekeeper/票据检查由正式构建门禁执行，失败不会输出成功清单。尚未完成的产品验收包括：无开发依赖的干净机器安装、真实下载中断与冷机磁盘峰值、新用户登录/取消现场、中文候选浮窗的独立视觉检查。登录与下载异常已有确定性测试，不能替代上述真实现场。

第一次正式构建在 electron-builder 的签名身份选择器处失败，已修复完整身份名称与 builder 选择器的格式差异。下一轮已完成 App 签名并提交公证；运行内置 Python 时发现 `-I` 仍会更新 `.pyc`，实际 `codesign` 报资源封装失效，诊断保留在 `signed-python-cache-failure.log`。该轮构建已停止，不计为成功产物。宿主文件读取、PTY 和登录包装器随后统一使用 `-I -B`；真实内置 Python 专项验证标准库源码、缓存及新模块导入均不写入，32 项专项通过。正式打包增加运行后的签名复验。

Python 修复后的签名 App 运行前后封装检查通过，完整包内 E2E 首轮 61 passed / 1 failed / 2 skipped；唯一失败为保存按钮恢复可用前按 Tab 的测试时序，补充明确等待后安装测试 2/2 通过，全部原断言保留。5 项真实模型检查及 SSH/SFTP 均通过。随后 Apple 公证返回 `Invalid`，指出 Linux guest 的 pnpm 归档夹带 macOS reflink 原生模块。载荷制作增加按目标平台裁剪，并在准备与正式打包时审计实际归档中的二进制格式和 ARM64 架构，防止复用旧缓存再次送审。各轮详情和未完成项见 [SIGNED-RESULTS.md](SIGNED-RESULTS.md)。

平台裁剪修复后的打包专项为 26/26 通过。重新制作的 guest 归档在真实专属沙箱全新临时目录完成散列、Node/pnpm/Codex 探针及 `pnpm install --offline` 本地文件依赖安装；下载计数为 0，Node 实际读取依赖成功。原有全局工具未被覆盖。新的正式构建日志为 `package-signed-platform-fixed.log`，App 与 DMG 公证及最终产物检查均已成功；干净机器安装验收仍未执行。

用户随后要求增加 GitHub Release 自动发布配置。工作流及凭据准备说明见 [GitHub Release 流程](../../development/github-release.md)；本机钥匙串中的身份与公证 profile 不等于 GitHub 已配置凭据。远端流水线是否已运行必须以对应 Actions run 为证据。

自动发布及打包专项最终合计 26/26 通过，覆盖标签/版本与提交一致性、文件损坏拒绝、draft 上传后核验、重复运行、已发布资产保护、标签被移动时拒绝发布及敏感错误脱敏。官方 actionlint 1.7.12 校验工作流通过（未额外运行 shellcheck/pyflakes）；基线自检 12/12 通过，文档链接检查通过。这些本地检查没有触发真实 GitHub Release 发布。已在目标仓库配置非敏感签名身份和团队变量，四项签名及公证 Secrets 仍需安全配置。

## 真实沙箱安装和恢复

在本轮独有的本地测试 App 副本上封装 ad-hoc 签名，仅供安装器检查使用；没有删除 quarantine 或将它计作正式签名。使用真实 SetupManager 和 NativeSetupAdapter 驱动安装后端，复用已有 sbx 与认证，未进行重新登录。

新建沙箱 `wsl-competition-b0a7c880-5148-4cef-b4b5-ca5d4fd10cf0`，固定基础镜像、2 CPU、4 GiB、无宿主挂载。仅对该沙箱拒绝 `registry.npmjs.org` 和 `nodejs.org`，实际策略结果见 [npm-deny.json](npm-deny.json) 与 [node-deny.json](node-deny.json)。随后复制包内完整载荷、核对散列、解包，并通过 Node 24.21.0、pnpm 10.34.6、Codex 0.160.0、Python PTY/SSL、Git 和 CA 探针。状态达到 ready，真实模型状态仍单独记录。

真实执行发现并修复两处错误：codesign 内联 requirement 需要 `=` 前缀；sbx cp 保留宿主 UID，使普通 guest 用户不能删除 sticky `/tmp` 下的临时归档，改为 sudo 清理固定安装归档路径。修复前后重试保留同一沙箱身份，未重复创建；相关源码回归测试已补充。既有 `wsl-sbx-smoke-20261006` 保留，未作为本轮安装目标。

本机测试副本位于 `~/Applications/Web Studio Lab Installer Test.app`，安装配置位于 `/private/tmp/wsl-installer-20261009-profile/runtime.json`。这些是本轮测试资源，不能据此宣称用户在干净机器从 DMG 双击安装已通过。

## 原生窗口补验

使用 LaunchServices 启动独立空白 profile `/private/tmp/wsl-installer-native-20261009`，调用环境清空后仅保留 HOME 和系统 PATH，未传入 WSL 配置。首次窗口显示安装设置、未选择沙箱及本地未授权；真实条件检查完成后 busy=false / error=null。实际 NSOpenPanel 取消后目录仍为 null；发现的焦点丢失已修复并定向复验。

在原生 SSH 用户名字段逐键输入拼音，经空格选词得到“测试”，组字确认没有触发配置保存。组字下划线与字段焦点可见；截图范围未覆盖独立候选浮窗，因此不把该浮窗视觉验收记为通过。原生窗口正常退出；没有保存测试 SSH 参数或改变用户的原有工作空间。
