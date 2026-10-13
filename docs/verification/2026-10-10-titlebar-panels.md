# 标题栏侧栏入口与收起布局

本轮将左栏入口合并到左上角 W 标识按钮，将通知入口移到右上角铃铛；收起时两侧不再保留 44px 空栏。用户要求做出更改并查看效果，本轮完成本地源码实现、构建、定向回归及真实 Electron 截图，尚未经过用户视觉接受。

## 基线与范围

目录 `/Users/huaodong/workspace/web-studio-lab`，HEAD `cf62dc74f49e7f9e81598be7b9e5109cf5946e9c`。开始时已有 logo 和关闭流程相关脏改动，先在 `/private/tmp/wsl-titlebar-panels-before/` 保存 patch、49 个既有文件的 SHA-256 和真实窗口截图。交付复核其中 45 个文件完全一致；其余 4 个是本轮有意修改的 `DESIGN.md`、`TitleBar.tsx`、`app.css`、`e2e/branding.spec.ts`。关闭流程、品牌 SVG/PNG/ICNS 和历史验证记录未改写。

实现由 coder 完成，主线程审阅源码、测试 diff，并独立启动隔离 profile 采集和查看截图。使用本机 pnpm 10.34.6，未使用系统默认的 pnpm 11。

## 行为与路径

- `apps/desktop/src/renderer/src/shell/TitleBar.tsx`、`components/Icon.tsx`：34px 标题栏按钮，W 图像与铃铛各有可访问名称、实际展开状态和快捷键提示；零未读不显示角标。
- `shell/Workshop.tsx`、`shell/RightPanel.tsx`、`styles/app.css`：删除边缘把手、悬停定时器及留白；收起不渲染侧栏，临时浮层距左右边缘 8px，固定栏继续参与布局。默认固定偏好不变。
- `App.tsx`、`state/shell.ts`：外部点击收起临时栏且不抢走输入焦点；Escape 和关闭按钮恢复入口焦点。两栏可并存，菜单/对话框优先处理关闭。专注模式下点击入口会退出专注并正常展开。沿用原生网页遮挡集合，不新增第二套状态。
- `DESIGN.md`、`UX-CONTRACT.md`：同步当前入口、点击行为、焦点和布局约定。
- `state/shell.test.ts`、`e2e/space-remake.spec.ts`、`e2e/branding.spec.ts`、`e2e/workbench.spec.ts`、`e2e/workspace-upgrade.spec.ts`：覆盖新行为并更新旧入口定位；`e2e/workspace-observation.spec.ts` 仅更正过时悬停注释。

## 实际验证

| 检查                                                                                                                                                                              | 结果                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `pnpm typecheck`                                                                                                                                                                  | passed，包含产品、E2E、baseline 类型检查                                  |
| `pnpm build`                                                                                                                                                                      | passed，构建 service/main/preload/renderer                                |
| `pnpm exec eslint`，参数为本轮受影响 TS/TSX 文件                                                                                                                                  | passed                                                                    |
| `pnpm exec prettier --check`，参数为本轮 15 个源码、样式、契约和测试文件                                                                                                          | passed                                                                    |
| `pnpm exec vitest run apps/desktop/src/renderer/src/state/shell.test.ts apps/desktop/src/renderer/src/state/panels.test.ts apps/desktop/src/renderer/src/state/occlusion.test.ts` | 13/13 passed                                                              |
| `pnpm exec playwright test e2e/space-remake.spec.ts e2e/workspace-upgrade.spec.ts e2e/branding.spec.ts`                                                                           | 15/15 passed，19.1s                                                       |
| `pnpm exec playwright test e2e/workbench.spec.ts --grep 侧栏`                                                                                                                     | 1/1 passed，1.3s                                                          |
| frontend-design-premium `audit_project.py --mode strict`                                                                                                                          | 0 findings；[审计结果](2026-10-10-titlebar-panels-evidence/ui-audit.json) |
| `designmd lint DESIGN.md`                                                                                                                                                         | 0 errors / 0 warnings，保留现有 omitted 声明                              |
| `node scripts/check-docs.mjs`、`git diff --check`                                                                                                                                 | passed，文档入口/链接/空白及 diff 空白检查                                |

首次 Electron 回归有 2 项失败：窄窗测试仍使用旧展开态名称，以及 CSS 尾部残留右侧 44px padding。修正入口定位和实际布局后原断言复验通过，没有删掉宽度断言。键盘、双栏/菜单并存、pin 重启与窄窗投影、原生网页显隐、输入焦点及三主题已在列明范围内验证。定向检查输出保留于任务执行记录，未另生成原始命令日志文件。

## 图像核对

以下均为构建后的真实 Electron renderer 截图，使用离线 fixture，没有调用真实模型；画面中的“已连接”是 fixture 状态。截图不包含系统红绿灯；普通 renderer 截图也不包含原生网页内容。左浮层画面中的网页让位占位是现有遮挡机制的真实状态，原生网页恢复另由 E2E 检查。

- [修改前两栏收起](2026-10-10-titlebar-panels-evidence/before-collapsed.png)：1440px 窗口，主内容 x=44、宽1352。
- [修改后两栏收起](2026-10-10-titlebar-panels-evidence/collapsed-light.png)：相同窗口与首页状态，主内容 x=0、宽1440，释放88px。
- [通知展开](2026-10-10-titlebar-panels-evidence/notifications-light.png)、[左栏展开](2026-10-10-titlebar-panels-evidence/workshop-light.png)：完整浮层、固定/关闭入口，标题栏按钮仍可见。
- [深色收起](2026-10-10-titlebar-panels-evidence/collapsed-dark.png)、[深色通知](2026-10-10-titlebar-panels-evidence/notifications-dark.png)、[暖色960px窄窗](2026-10-10-titlebar-panels-evidence/collapsed-warm-960.png)：无入口裁切；窄窗内容宽960、无横向溢出，见[布局测量](2026-10-10-titlebar-panels-evidence/visual-metrics.json)。

本轮未运行全量业务、真实模型、发布安装包或全仓库验收，未提交、推送、发布或安装到 Applications。新增的未读角标正数分支未单独采集截图；零未读隐藏由 E2E 验证。验证结论限定于本轮 UI 与上述回归范围。
