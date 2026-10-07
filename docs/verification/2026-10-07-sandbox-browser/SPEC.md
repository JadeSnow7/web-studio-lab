# Guest 浏览器最小验收桥接

2026-10-07 用户批准：启动既有测试 sandbox 清点，在隔离工作树实现最小 guest Chromium / Playwright / CDP 桥接，仅该 sandbox 放行 `docs.docker.com:443`，验证真实页面、截图、空间资源与 MCP 的版本和摘要。缺失组件另行确认安装；本轮不调用模型、不改全局代理、不提交推送。

## 本轮边界

入口是 `apps/service/src/guest-browser.live.test.ts`，须显式设置 `WSL_LIVE_GUEST_BROWSER=1`。这是独立 headless 验收切片；现有 Electron 地址栏、预览和捕获流程仍保留原合同，不宣称已经迁移到 guest。服务模块只接收固定 capture 请求，不提供任意 URL、文件路径、shell、JavaScript 或 CDP 方法参数。

现有 `wsl-sbx-smoke-20261006` 必须由用户授权启动，且运行时挂载为空。桥接不会创建 sandbox、改 ACL、下载依赖或启动模型；默认拒绝 stopped 状态。显式启用的真实验收入口带 startStoppedSandbox 授权标志，可启动同一个既有 sandbox。宿主使用既有 `sbx exec` 的 stdin/stdout 传输；Playwright、Chromium、页面导航、DOM 读取和 CDP 都在 Linux guest。浏览器使用新临时 profile，显式 `chromiumSandbox:true` 和 CDP pipe，不开放调试端口，不继承宿主浏览器资料。安全代理仍属于宿主出站路径。Chromium 显式连接既有 `http://gateway.docker.internal:3128` 沙箱代理网关，不接受请求方提供代理、凭据或 bypass 配置；固定来源及响应跳转拦截仍生效。

冷启动先只读等待固定 guest 的 `/proc/net/if_inet6`：必须出现 `eth0` 地址、没有 tentative 或 DADFAILED，完整规范化地址表连续稳定 200ms，最多等待 5s；DADFAILED、畸形/不可读证据或超时均失败。此等待位于 Chromium 启动前，响应原有取消与 45s 总预算，不改任何网络设置、不重试导航。它只避开已观测的 IPv6 DAD 启动窗口，不保证之后的网络不变；真实导航仍执行原严格失败处理。空表或仅 loopback 不作为已就绪证据。Linux 标志定义参考 https://raw.githubusercontent.com/torvalds/linux/master/include/uapi/linux/if_addr.h 。

真实运行前，检查 guest ELF/架构、实际浏览器参数、`chrome://sandbox`、renderer 的 PID namespace、NoNewPrivs 与相对 browser 增加的 seccomp filters。任何隔离证据缺失都失败，不退回 `--no-sandbox`，也不修改内核、root 权限或 capabilities。内部诊断表兼容旧版 `Namespace sandbox: Yes/Enabled` 与 Chromium 153 的 `Layer 1 Sandbox: Namespace`；只接受完整标签和明确状态，未知、重复或冲突行均不能作为通过证据。此兼容不替代 renderer 进程限制与 namespace 的独立核验。启动时显式加入 `--enable-automation`，满足 CDP `Browser.getBrowserCommandLine` 的命令行核验前提；控制仍仅使用内部 pipe。

仅固定 HTTPS 根 URL `https://docs.docker.com/` 可作为主导航；只接受同源 GET 子资源，拒绝跳转、其它域名、frame、worker、WebSocket、下载和新窗口。对响应追加限制 frame/worker/object/form 的 CSP，同时保留原 CSP。此模式允许受限原站渲染，但不承诺站点所有功能和外部字体/CDN 可用。被阻止与失败的子资源单独记录，日志不采集 cookies、headers、console 或 URL 查询参数。

## 同一产物与资源身份

固定请求的 `captureId` 由宿主生成。主响应绑定 requestId、loaderId 和导航 epoch；正文、DOM、PNG 与 target 的采集前后检查同一文档，并检测 DOM 变化。导航或采集期间变化导致失败。截图显式保留 caret 与动画原状，避免采集器隐藏输入框光标时写入/恢复 style 被自身 observer 计数；不清零、不忽略任何 DOM 变动记录。输出有界单行 JSON（最多 4 MiB），包含最多 64 KiB 的 DOM 正文和最多 2 MiB 的固定 1280×800 PNG。响应字节上限 2 MiB；总时间、请求数量也有限制。

`rendered-dom-text-v1` 是新的严格资源类型；旧 `html-text-v1` 字段和行为保留。guest 来源记录 sandboxName、browserInstanceId、targetId、navigationEpoch，不伪造 Electron webContentsId。`sourceSha256` 明确表示 Chromium 解码后的主响应正文，不是原始网络传输字节；`contentSha256` 表示返回 DOM 正文的 UTF-8 字节；`screenshotSha256` 表示 PNG 文件。宿主核对 captureId、URL、来源、正文摘要、PNG 摘要、固定尺寸和清理回执后才能保存。

空间仍通过既有 `ResourceStore` 原子保存，截图保存在独立受限 artifact 路径，资源包只带摘要。完整 guest 快照相同的重试幂等；capture/time/navigation/source/screenshot 变化均创建新版本。同 URL 从宿主切换到 guest 也必须创建新版本，不能复用旧来源身份。测试使用报告目录内的独立 `taskflow-demo` 存储，不覆盖用户现有应用资料。

Python MCP 同步严格校验 guest 类型，保持 sealed memfd、只读工具、精确 resourceId/version、会话空间隔离与大小限制。真实验收使用 stdio MCP 的 list/read，核对完整保存资源与 PNG 摘要，并拒绝错误版本。没有真实截图/DOM 时不得构造一个资源来替代；合成离线测试单独标注。模型级验证本轮明确不运行。

## 验收与收尾

- 离线：严格字段、来源兼容、版本幂等、摘要替换、进程清理和网络决策回归。
- 实际 guest：标准库 MCP 与 sealed memfd 测试使用标明的合成资源，不能算真实网页验收。
- 实际浏览器：依赖齐全后运行真实入口；失败保留明确结果，后续资源和 MCP 步骤不运行。
- 每次暂停/结束：记录开放 PR 未解决评审；停止本次 sandbox 进程，恢复原 stopped/mountless 状态；仅撤销当次新增网络 rule ID，保留其它规则、代码和证据。

证据目录：`~/workspace/_agent-reports/20261007/sandbox-browser-test/`。组件安装、其所需网络域名和 root 包管理动作尚须单独批准；不执行可能隐式下载安装的 `npx` 或 `playwright install-deps`。
