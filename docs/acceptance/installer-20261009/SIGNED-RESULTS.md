# 签名包复验与交付状态

最终 App 和 DMG 已通过 Developer ID 签名、Apple 公证、票据装订与本机 Gatekeeper 检查，DMG/ZIP 已生成。最终公证 App 的五项 CI smoke 和运行后资源签名复验通过。干净 Mac 下载并保留 quarantine 的安装验收仍未执行。

## 平台裁剪前的签名包复验

- 使用身份 `Developer ID Application: Aodong Hu (6429YPLDYU)`，公证凭据使用本机钥匙串的 `wsl-notary` profile。
- 宿主 Python 启动入口使用 `-I -B`。签名后的 SSL、PTY 探针通过，探针前后 `codesign --verify --deep --strict` 通过；完整包内回归后再次通过。日志为 `signed-python-fixed-probe.log` 和 `signed-post-e2e-seal.log`。
- App 内 Python 执行文件 SHA-256：`4f8a270268fb8229c66c1782bbfac84fe8463db7a236ae0c38730b611b6ed7fc`；guest 离线归档 SHA-256：`35597c73108a672d91b28c220685f449552559d7bc980cb0a3a7ff17c6aaa072`。两项均与包内清单匹配。
- 完整签名包 E2E 首轮为 61 passed / 1 failed / 2 skipped。唯一失败是安装设置测试在保存按钮仍禁用时按 Tab，测试改为等待按钮恢复可用后执行原有焦点断言；产品代码未改变。该文件两项复验均通过。日志为 `e2e-signed-final.log` 和 `e2e-signed-installer-retry.log`，没有覆盖首轮失败证据。
- 5 项真实模型检查均通过：中文续聊、三来源统一观察、真实公开网页 MCP 读取、终端未知 nonce 同沙箱读取、跨空间 PTY/模型归属。受控 loopback 服务器上的 SSH agent、SFTP、PTY 与错误指纹检查通过。其余产品与历史验收边界见 [RESULTS.md](RESULTS.md)。

## 历史公证失败

正式构建日志为 `package-signed-python-fixed.log`。修复后 App 的 Apple 请求 ID 为 `04eca3fe-e34d-441e-9b91-e56a6ea94103`，提交于 `2026-10-08T18:20:16.852Z`；最终结果为 `Invalid`。公证诊断指出 guest 归档中的 `pnpm/dist/reflink.darwin-arm64-2HJ4WGO6.node` 和 `reflink.darwin-x64-3G3H6IW4.node` 没有有效 Developer ID 签名和安全时间戳。这些并非 Linux ARM64 guest 所需的运行文件，应在载荷制作时按目标平台裁剪，并验证实际 Linux 工具功能。被停止的上一轮请求为 `4fd975de-50b6-4732-9518-19ac95ea9f2c`，不作为本轮交付依据。

该轮构建失败停止，没有生成成功发行清单；后续修复与最终成功产物单独记录如下。`release-internal/` 产物不作为正式签名交付。

## guest 平台裁剪修复

已从 pnpm 载荷移除 6 个仅供 macOS/Windows 使用的文件，保留 Linux ARM64 Node、Codex 及其动态库。源归档锁没有变；重新生成的 guest 归档 SHA-256 为 `ae36ded1968afb362aa3b208fc75cdc128039cadfa3c851a2e0ece27675615cf`。准备和正式打包均直接审计归档字节，旧载荷即使与旧清单散列匹配也会被拒绝。打包专项 26/26 通过，日志为 `packaging-platform-tests.log`。

真实专属沙箱的全新临时目录中，解包、散列、Node 24.21.0、pnpm 10.34.6、Codex 0.160.0 探针通过；`pnpm install --offline` 实际安装本地文件依赖，输出 downloaded 0，Node 成功读取依赖导出值。临时文件随后清理，既有全局工具与用户工作目录未修改。日志为 `guest-platform-live.log`。这证明裁剪没有破坏所测工具路径，不代表 sbx 与基础镜像已支持整机离线安装。

## 最终公证产物

修复后的正式构建 `package-signed-platform-fixed.log` 退出码为 0。App 与 DMG 公证成功，`codesign`、`spctl`、`stapler` 检查全部通过；DMG 公证请求 `6835e05e-8bb5-4087-b0d7-954c73935ad6` 为 `Accepted`。原始发行清单留存于 [notarized-release-manifest.json](notarized-release-manifest.json)。

| 产物                               | SHA-256                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| Web Studio Lab-0.1.0-arm64.dmg     | `414f93392b155f61fdc1325fc4b7210f1b327a4928b0ac56a14cf5d32902688c` |
| Web Studio Lab-0.1.0-arm64-mac.zip | `e8a08e93d1b9955ef942f9eecb4b9e00dcd61878d78d1aea2bc769f90bd84262` |

产物位于 `apps/desktop/release/`，未纳入 Git。构建基于基线提交及当时未提交的实现，清单保留原始源码指纹；此后更新交付记录不会将该产物改称为后续提交的重建结果。

最终公证 App 使用 CI 相同入口执行安装设置恢复、损坏配置首启、本地文件、未配置环境和本地 PTY 五项 smoke，5/5 通过，日志为 `e2e-notarized-ci-smoke.log`。随后内置 Python SSL/PTY 探针及探针前后严格签名检查通过，日志为 `notarized-post-smoke-seal.log`。最终轮未重跑全套 live 测试，之前各轮完整回归保持上述证据边界。

## GitHub 自动发布

[工作流](../../../.github/workflows/release.yml)与[配置说明](../../development/github-release.md)已实现并审查。451 项单元、26 项打包/发布专项、12 项基线自检、类型检查及 actionlint 通过。定向 lint 排除生成的 `release-internal/`，不修改历史源码问题。

已在目标仓库配置 `MACOS_SIGNING_IDENTITY` 和 `APPLE_TEAM_ID` 两项 Variables。签名证书、公证账号等四项 Secrets 尚待用户在 GitHub 安全配置。交付分支为 `codex/competition-installer`，通过 Draft PR 审查后再合入默认分支。工作流仅响应版本标签与手动触发，分支推送和 Draft PR 不会自动发布。尚无云端构建或 GitHub Release 发布验收。
