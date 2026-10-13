# 空间 App 模型：本地实现与验收记录

本轮完成空间内单个标准 App 的持久描述、创建/编辑界面和元素修改任务定位补全，局部实现、单元测试与 Electron 窗口回归通过。真实 sandbox 创建和真实模型修改未运行，不据此认定完整比赛闭环或用户接受通过。

基线为 `v0.1.5` / `cf62dc74f49e7f9e81598be7b9e5109cf5946e9c`，分支 `codex/space-app-model`，独立工作树 `/private/tmp/web-studio-lab-space-app-model`。主仓库保持干净；所有改动本地未提交，未推送、打包、发布或部署。Node `v26.5.0`、pnpm `10.34.6`；命令从此工作树执行，使用 `PATH=/private/tmp/wsl-pnpm10:$PATH` 选择规定 pnpm。

## 改动与使用

从空间侧栏点击“创建标准应用”，输入 App 名称和说明并保存；已有 App 使用“编辑 App”。创建仍调用既有标准模板与沙箱服务。名称/说明编辑只更新描述及 App 浏览器标签名称，不重启应用、不更换工程和浏览器身份。已有启动、停止、导出及元素采集入口保留。

- `packages/protocol/src/managed-app.ts`、`workspace.ts`：新增 `SpaceApp` 和版本化更新命令，区分 App 描述与 `managedApp` 运行状态，任务版本增加冻结的 App 工程信息。
- `apps/desktop/src/main/workbench/application.ts`、`repository.ts`：Main 单点写入，描述版本冲突、跨空间身份、存储失败及旧数据迁移检查；schema v1/v2 显式迁移至 v3，保留项目/资源和历史，不自动执行进程。迁移后的 App ID 由旧 projectId 确定，新建 App 独立分配 ID。
- `apps/desktop/src/renderer/src/workspace/AppEditor.tsx`、`Sidebar.tsx`，以及 `pages/SpacePage.tsx`、`state/space-ui.ts`、`shell/Overlays.tsx`：共享创建/编辑表单，固定接收空间和描述版本，保留失败草稿，IME 安全提交，禁止重复保存；稳定页面层承载表单，缩窄窗口不丢草稿。
- 元素修改任务传递页面身份、selector、testId、元素文本和位置，以及 Main 绑定的项目路径；截图保留在现场证据，不作为 base64 文本发送。页面数据明确不授予权限；现场过期或组合文本超过 32000 字符在创建 run 前拒绝。

创建失败保留已登记的 App/projectId 与错误；后续描述保存不会重放沙箱创建。现有服务不提供部分创建失败后的自动重建，仍须核对既有工程/清理状态。普通元数据编辑无此限制。

## 实际验证

实施前输入与验收项见 [SPEC](SPEC.md)。本轮最终代码散列见 [source-manifest.json](source-manifest.json)。以下结果不包含真实模型或 sandbox live。

| 命令/检查                                                                      | 结果                                                  | 证据与范围                                                                                                                   |
| ------------------------------------------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 原有两个 Workbench 测试文件                                                    | passed：35 tests                                      | [baseline-tests-direct.txt](baseline-tests-direct.txt)，实现前直接调用已安装 Vitest                                          |
| `pnpm check`                                                                   | failed，在 lint 阶段停止                              | [check.txt](check.txt)，首轮含5项新增lint错误，均已修复；不能将此命令算作全绿                                                |
| `pnpm typecheck`                                                               | passed                                                | [typecheck-final.txt](typecheck-final.txt)                                                                                   |
| `pnpm lint`                                                                    | failed：217项历史问题                                 | [lint-final.txt](lint-final.txt)，命中既有存档及未修改的固定基线，不删除断言或改封存材料                                     |
| `pnpm format:check`                                                            | failed：731个文件提示                                 | [format-full.txt](format-full.txt)，包含历史存档、固定基线、README原表格及当时尚未格式化的本轮文件；本轮代码随后定向检查通过 |
| 定向 ESLint / Prettier                                                         | passed：14个源码/测试文件；相关新文档检查通过         | [lint-changed.txt](lint-changed.txt)、[format-changed.txt](format-changed.txt)；README保留旧表格原字节，仅新增末尾段落       |
| `pnpm test`                                                                    | passed：514 tests；15 skipped；另27项打包脚本测试通过 | [test-full.txt](test-full.txt)，代码与适配器离线回归                                                                         |
| 最终四个 Workbench 测试文件                                                    | passed：44 tests                                      | [test-focused-final.txt](test-focused-final.txt)，模型、描述编辑、迁移、保存失败回滚、定位及大截图、过期现场、超长输入       |
| `pnpm build`                                                                   | passed                                                | [build-final.txt](build-final.txt)；其后稳定页面修复的构建亦由完整 E2E 命令重新完成                                          |
| `pnpm test:e2e`                                                                | passed：61；7 skipped                                 | [e2e-full.txt](e2e-full.txt)，真实 Electron 窗口；显式关闭全部 live 标志                                                     |
| `pnpm baseline:selftest`                                                       | passed：12 tests                                      | [baseline-selftest-unsandboxed.txt](baseline-selftest-unsandboxed.txt)，仅合成离线固定基线，不代表 VS001 产品验收            |
| Premium strict audit                                                           | passed：0 findings                                    | [premium-final-stable.json](premium-final-stable.json)，只属于静态证据                                                       |
| `node scripts/check-docs.mjs`、`git diff --check`、`git diff --cached --check` | passed                                                | [docs-final.txt](docs-final.txt)；链接/空白与diff检查不替代行为验收                                                          |

仓库 `premium-ui.json` 指定的 `playwright test e2e/sbx.spec.ts e2e/chat.spec.ts e2e/resources.spec.ts` 单独执行为11项通过、2项跳过，结果见 [accessibility-configured.txt](accessibility-configured.txt)。这是配置中的交互检查，不等于完整 WCAG 或屏幕阅读器验收。

## 窗口与审阅证据

最终 `e2e/space-app.spec.ts` 三项通过，见 [e2e-focused-final.txt](e2e-focused-final.txt)：缺失 sandbox 的真实 Main 失败路径保留登记身份和草稿；受控 UI transport fixture 验证成功创建、编辑与冲突后重复保存拒绝。成功 fixture 不证明实际 sandbox 工程创建。全量61/7回归后，仅补强该测试文件：双击后明确核对Main收到创建请求恰为1次；新增暗色主题、200字名称、2000字说明、程序composition事件下Enter不创建及窄窗按钮可达/取消检查。三项定向重跑通过，该文件ESLint、Prettier与E2E类型检查再次通过；未重复运行无改动产品代码的全套回归。程序事件不代表操作系统输入法候选窗验收。既有原生 Browser 点选、页面身份与导航失效回归通过，App 项目定位用 Main 单元测试验证；真实 App 页面到模型的修改闭环未运行。

初次新 E2E 为1通过/1失败，发现编辑中缩窄原生窗口后 Sidebar 卸载导致表单消失，保留 [e2e-focused.txt](e2e-focused.txt)。已将表单移至稳定的 SpacePage，并保留原断言，新增缩窄后修改说明、保存并核对权威快照。完整回归中的两项均通过。

主线程实际查看了以下截图，并与同轮既有页面截图核对：共享字体、颜色、字段和按钮保持一致，窄窗表单与操作可见，失败与冲突提示保留。测试请求窗口900×700，产品最小宽度960使实际宽度钳制为960；截图按2倍显示比例生成。renderer 截图不包含原生 WebContentsView 像素，不当作完整窗口合成证明。

- [窄窗编辑表单](screens/space-app-editor-narrow.png)：草稿与保存入口保留。
- [暗色长内容表单](screens/space-app-editor-dark-long-ime.png)：字段可滚动、文字与按钮可见。
- [受控 App 侧栏](screens/space-app-sidebar-fixture.png)：名称、运行状态及编辑入口；图中数据明确来自fixture。

首轮依赖安装因系统 pnpm 11 与受限网络失败，随后用规定 pnpm 10.34.6 成功安装并恢复安装副作用。最初自检被沙箱阻止创建 tsx IPC 管道，升级执行同一离线命令后通过。原始失败日志与初次静态审计保留，未改写为成功。

## 未验证与未扩展

真实 sandbox 创建/启动、真实模型修改、正式签名打包、发布、VS001真实模型五项和用户接受均为 `not_run`；前两项需要独立 live 授权，其余不属于本轮交付。没有增加多 App、第二模板、完整代码编辑器或云部署。全仓lint/格式仍存在上述历史失败，本轮只交付目标范围实现及本地验证。
