# Workshop 分类创建入口（2026-10-10）

本轮移除空间侧栏底部的“标准应用”常驻区域，在原“空间标签”文字位置提供网页、终端、会话与 App 四个图标按钮。按钮连接现有 Main workbench 用例，不新增执行服务或扩大资源权限。主线程已审阅 coder 的[本次源码增量](2026-10-10-workshop-actions-evidence/implementation.patch)，最终源码和测试指纹见 [source-sha256.txt](2026-10-10-workshop-actions-evidence/source-sha256.txt)。

## 范围与行为

- `workspace/Sidebar.tsx`、`shell/Workshop.tsx`：分类创建入口、中文提示与可访问名称；底部通用新建标签保留文件和 SSH 入口。
- `pages/SpacePage.tsx`、`state/space-ui.ts`：预选资源类型，网页可输入地址，错误保留表单内容，创建命令固定目标空间；终端仍需选择环境并显式连接，会话不自动发送消息。
- `workspace/ManagedAppDialog.tsx`：App 创建、启动、停止/取消、导出及状态集中展示；沿用现有原生网页遮挡、modal、Escape 和焦点恢复。关闭不停止应用，在途操作与错误按空间隔离。
- `styles/app.css`：沿用共享图标与主题，仅增加顶部按钮几何和管理对话框布局。
- `e2e/workshop-actions.spec.ts`、`e2e/fixtures/sbx-app-actions.mjs`：确定性 Electron 窗口回归；`e2e/managed-app-live.spec.ts` 跟随新入口调整，未运行 live。
- README、DESIGN、UX-CONTRACT、current-runtime 同步当前入口。

上述源文件相对于 `apps/desktop/src/renderer/src`。起点为主工作树 `codex/c1-development-20261010`、HEAD `cf62dc74f49e7f9e81598be7b9e5109cf5946e9c`，已有大量 dirty/untracked 内容。本轮保留这些修改，只审阅本次增量，不代表整个工作树已验收。

## 验证条件与证据

Node `v26.5.0`、pnpm `10.34.6`。环境默认 pnpm 为 11，因此实际命令使用已核实的缓存入口：`node /Users/huaodong/.npm/_npx/168ca33e231eaaf0/node_modules/pnpm/bin/pnpm.cjs`；下表以 `pnpm` 简写。首次受限测试因本机端口/Unix socket `EPERM` 与文件监听 `EMFILE` 失败，允许使用本机测试能力后重跑；不修改断言规避限制。

| 检查                        | 结果与边界                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                 | passed：571 单测通过、15 显式跳过；27 打包工具测试通过。见 [unit.txt](2026-10-10-workshop-actions-evidence/unit.txt)                  |
| `pnpm baseline:selftest`    | passed：12 项合成基线自检，不是产品 live 验收。见 [baseline-selftest.txt](2026-10-10-workshop-actions-evidence/baseline-selftest.txt) |
| 修改前 `pnpm lint`          | failed：3781 项既有错误，包含 records 下生成依赖和固定基线 cdp.ts；没有批量修改历史或无关文件                                         |
| 修改前 `pnpm format:check`  | failed：792 个既有文件不符合当前格式器；历史证据保持原意                                                                              |
| 设计文档 lint、文档入口检查 | passed：DESIGN 0 errors / 0 warnings；18 个规范入口及本地链接检查通过                                                                 |

补充检查：

- `pnpm typecheck`、`pnpm build`：passed，见 [typecheck.txt](2026-10-10-workshop-actions-evidence/typecheck.txt)、[build.txt](2026-10-10-workshop-actions-evidence/build.txt)。构建有上游 PURE 注释告警，未阻止构建。
- `pnpm test:e2e`：passed，79 项通过、7 项显式跳过，见 [e2e.txt](2026-10-10-workshop-actions-evidence/e2e.txt)。其中新增 3 组用例覆盖类型预选、实际快照、重复提交、网页地址失败恢复、终端环境选择、会话不执行、App 创建与导出文件、取消启动与清理回执、启动失败、重启恢复，以及 A 空间操作仍在途时 B 空间 App 对话框的忙态和错误隔离。
- 修改源码与测试文件的定向 ESLint / Prettier、`git diff --check`：passed。README 原有格式告警单列，不批量格式化。
- 按 premium-ui 配置单独执行 `pnpm exec playwright test e2e/sbx.spec.ts e2e/chat.spec.ts e2e/resources.spec.ts`：passed，11 项通过、2 项 live 跳过，见 [accessibility.txt](2026-10-10-workshop-actions-evidence/accessibility.txt)。这是配置中的交互检查，不代表完整 WCAG 审计。
- Premium strict 静态审计：passed，0 findings，见 [ui-audit.json](2026-10-10-workshop-actions-evidence/ui-audit.json)。不将静态审计当作运行验证。

主线程对照用户原图查看了[深色主界面](2026-10-10-workshop-actions-evidence/workshop-actions-dark.png)、[窄窗](2026-10-10-workshop-actions-evidence/workshop-actions-narrow.png)和 [App 管理](2026-10-10-workshop-actions-evidence/workshop-actions-app.png)：四个图标与当前空间名同排，底部区域移除，窄窗入口完整，管理对话框沿用共享样式。Renderer 截图用于检查本轮外壳；原生网页内容不由这些截图证明。

真实沙箱、模型、公网加载、正式打包与发布未运行。App 窗口测试使用明确标识的 fixture，只证明产品 UI 到现有命令/服务协议的连接及错误恢复，不能证明真实 Linux 模板服务健康或模型能力。跨空间隔离的结论限定为新增 App 对话框，既有通用命令错误仍使用全局提示。代码、自动验证和用户接受分别记录；本轮未提交、推送或发布。
