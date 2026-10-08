# 2026-10-06 第一版 Electron 界面验证记录

对应任务：T14（前半：Electron 集成、同页点选、打包）、T15（点选、现场采集与任务确认的界面部分）、T05（最小 Workshop / Browser 界面）。本记录只覆盖界面与桌面宿主，**不包含真实模型、执行服务或业务验收**。

## 实现前状态（基准）

- 当前目录 HEAD `643c1e2`，分支 `docs/dev-conventions`。仓库只有 README、CLAUDE.md、CONTRIBUTING.md、`docs/ARCHITECTURE.md`、许可证与忽略规则；没有 `package.json`、锁文件、源码或可运行入口。
- 未跟踪文件：交互设计规范 v0.2（docx / pdf）、`premium-audit.json`。本轮没有修改它们。
- 本机环境：macOS 26.6.2（arm64），Node 26.5.0，没有 pnpm，也没有 Corepack。
- 本轮的最小测试基准（实现前确定）：
  1. `pnpm check` 通过：类型检查、ESLint、Prettier、Vitest。
  2. 状态与协议单元测试覆盖：Workshop 显示状态、首页个人作用域与草稿路由、现场有效性与任务版本、审阅规则、演示记录符合协议、IPC 发送者校验、导航白名单、演示目录越界。
  3. 真实 Electron 窗口检查：启动与安全边界、导航、面板、Tab、中文输入、页面点选与截图、导航失效、1440×900 与较窄窗口布局。
  4. 打包 macOS Apple Silicon 试用包，并在包内重复第 3 项。

## 结果

| 检查                       | 方法                                                            | 结果                                                                                                                                               | 原始输出                                                           |
| -------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 依赖安装                   | `npx pnpm@10.34.6 install --frozen-lockfile`                    | 通过（锁文件无变化）                                                                                                                               | —                                                                  |
| 类型、lint、格式、单元测试 | `pnpm check`                                                    | 通过；Vitest 7 个文件 46 项                                                                                                                        | [logs/pnpm-check.log](logs/pnpm-check.log)                         |
| 构建产物上的端到端检查     | `pnpm test:e2e`（Playwright 驱动 Electron）                     | 10 项全部通过                                                                                                                                      | [logs/pnpm-test-e2e.log](logs/pnpm-test-e2e.log)                   |
| 打包                       | `pnpm package`                                                  | 生成 dmg 与 zip（arm64），未签名                                                                                                                   | [logs/pnpm-package.log](logs/pnpm-package.log)                     |
| 打包后的端到端检查         | `pnpm test:e2e:packaged`                                        | 10 项全部通过                                                                                                                                      | [logs/pnpm-test-e2e-packaged.log](logs/pnpm-test-e2e-packaged.log) |
| 签名状态                   | `codesign -dv`、`spctl -a -vv`                                  | 只有链接器 ad-hoc 签名；Gatekeeper 评估不通过（预期）                                                                                              | [logs/package-signing.log](logs/package-signing.log)               |
| dmg 内容                   | `hdiutil attach -readonly` 后检查                               | 含 `Web Studio Lab.app` 与 `Applications` 链接；演示页面在 `Contents/Resources/demo/taskflow`；Bundle ID `dev.webstudiolab.desktop`，最低系统 13.0 | 本次会话终端输出                                                   |
| 开发模式                   | `pnpm dev` 后用 Playwright 连接同一 dev server 的 Electron 实例 | 工作台渲染正常，控制台无错误（含 CSP），`window.studio` 只有 preview / app / execution / shell                                                     | 本次会话终端输出                                                   |

端到端检查的内容见 [`e2e/workbench.spec.ts`](../../../e2e/workbench.spec.ts)。其中“选择模式中导航”一项在去掉修复后会失败（已实际验证），确认它能检出下面的缺陷。

### 真实窗口检查（打包后的 .app）

用系统级截图与输入操作打包后的应用：

- **合成画面**：原生 `WebContentsView` 与 renderer 的占位区域对齐，红绿灯安全区、顶栏标签、三栏结构与原型一致。见 [screens/real-window-packaged-capture.jpg](screens/real-window-packaged-capture.jpg)。
- **真实鼠标点选**：用系统鼠标事件（按下与抬起）点击演示页上的“移动端适配”，现场卡片显示 `a “移动端适配”`、元素截图、页面截图、`webContents #2 · 文档代次 1`。
- **真实 ⌘B**：焦点在 Browser 区页面里时按 ⌘B，Workshop 隐藏，再按一次恢复，说明菜单加速键不依赖 renderer 焦点。
- **临时展开**：点击左边缘把手后，Workshop 覆盖层显示在页面之上，背后换成同一页面的静态快照。见 [screens/real-window-workshop-overlay.jpg](screens/real-window-workshop-overlay.jpg)。
- **中文输入**：在右栏空间会话输入框写入中文后按回车，界面提示“未发送”及原因，草稿保留。

### 发现并修复的缺陷

- **选择模式残留**：第一次打包后在真实窗口中发现，选择模式中页面发生导航时，界面已显示“点选已取消”，但 CDP 的选择模式仍挂在页面上，鼠标悬停仍有高亮，后续点击会被拦截。见 [screens/real-window-bug-inspect-mode-left-on.jpg](screens/real-window-bug-inspect-mode-left-on.jpg)（修复前的包）。
- 修复：导航、取消和收到多余点选事件时都显式退出选择模式，退出失败如实显示原因（`apps/desktop/src/main/preview/controller.ts`）。
- 回归测试：e2e 第 5 项“选择模式中导航”。修复后重新打包，包内检查通过。

## 截图

`screens/` 下的 PNG 来自打包后的 e2e 运行：

- `NN-*.png` 是工作台 renderer 截图，不含原生页面视图。
- `NN-*.preview.png` 是同一时刻 Browser 区页面的截图。
- `real-window-*.jpg` 是系统截图，包含完整的合成画面。

| 文件                 | 内容                                         |
| -------------------- | -------------------------------------------- |
| 01-workbench-initial | 1440×900 初始工作台                          |
| 02-capture           | 点选后的现场卡片                             |
| 03-task-confirmed    | 确认任务 v1，真实运行按钮禁用并说明原因      |
| 04-capture-stale     | 导航后现场失效                               |
| 05-report-demo       | 验收报告视图（演示记录，带标识）             |
| 06-demo-cancelling   | 取消中：等待进程组退出                       |
| 07-home              | 首页个人作用域，右栏“选择空间后对话”         |
| 08-settings          | 设置：Codex CLI 未接入、能力未验证、版本信息 |
| 09-workshop-overlay  | Workshop 临时展开，页面以快照让位            |
| 10-narrow-overlay    | 1024×720：右栏改为覆盖层                     |
| 11-narrow            | 1024×720：收起右栏后的布局                   |

## 未验证或有假设

- **真实输入法组词未验证。** 中文是通过 CDP `insertText`（e2e）和辅助功能写值（真实窗口）输入的，都不经过输入法的组词阶段。组词期间按 Enter 不提交的逻辑（`isComposing` / keyCode 229）只做了代码层处理。
- **用真实鼠标悬停左边缘触发展开没有验证。** 系统截图工具把窗口内的坐标误判为程序坞，无法移动真实指针。e2e 检查了把手点击路径与覆盖层；160 ms / 300 ms 的悬停延迟没有实测。
- **辅助功能激活与点选。** 通过辅助功能（AXPress）激活页面元素会绕过选择模式，直接触发链接导航；界面能识别并提示“点选已取消”，但读屏用户目前无法完成点选。
- **DevTools 交接没有实测。** 菜单提供“打开 Browser 区页面 DevTools”，CDP 断开时有提示与“重新附着”按钮，但没有触发过真实的断开。
- **Node 24 没有单独验证。** 本地检查实际运行在 Node 26.5.0 上；`.nvmrc` 与 `engines` 按 Electron 44 内置的 Node 24 设定。
- **开发模式的真实窗口外观没有截图**：用户拒绝了对通用 Electron 应用的截屏授权，只验证了渲染与控制台。
- 截图以 data URL 形式保存在内存中，没有落盘。任务版本只保存在本次启动的内存里，重启后丢失。

## 未完成（本轮范围外或后续任务）

执行服务与限定 IPC 消息通道（T04）、Codex CLI 通路（T02）、母模板与三用例 fixture / 固定验收（T03）、证据落盘与 manifest、无模型复验入口（T09）、历史记录持久化（T11）、同页读取 / 点击 / 输入工具（T14 后半）、签名与公证。
