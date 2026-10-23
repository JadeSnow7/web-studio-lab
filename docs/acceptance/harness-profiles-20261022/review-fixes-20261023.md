# W4b 审批边界修复与复验（2026-10-23）

基于 PR #26 的 `3553158712489986c1272ca65cd9e330c0c785d8`，在其独立工作树修改；主工作树 `agent/simplify-ops` 的现有修改保留。本记录对应同一提交内的修复与测试，不把旧 head 的 CI 当作新代码验收。

## 修复及回归

- `apps/service/src/harness/acp/policy.ts`：自动拒绝只选择 `reject_once`，没有该选项就返回 `cancelled`，不再选择 `reject_always`。新增 `policy.test.ts` 覆盖 fetch/edit 仅有永久选项、正常一次性拒绝及选项过滤。
- `apps/desktop/src/renderer/src/components/PermissionRequests.tsx`：请求没有 `reject_once` 时仍显示“拒绝”，沿用 `optionId: null` 回复通道。不会生成或发送永久决定。
- `apps/service/src/fixtures/fake-acp-agent.mjs` 新增 `ask-no-reject-once` 场景；`codex-chat.test.ts` 验证永久拒绝 ID 被拒绝、空选项得到 `cancelled`、会话记录一次拒绝并清除待决请求。
- `e2e/harness-approvals-fallback.spec.ts` 在真实 Electron 窗口验证：服务选项只有 `allow_once` 时同时显示“允许一次”和“拒绝”；点击拒绝后 Agent 返回 `cancelled`、会话恢复 idle、卡片消失并记录拒绝。原有个人对话允许/拒绝及空间会话允许流程继续复验。

## 实际命令与结果

环境：macOS arm64，Node v26.5.0，pnpm 10.34.6，Electron 44.5.1。E2E 使用 fixture sbx 与假 ACP Agent，没有真实 sandbox 或模型调用。

| 命令                                                                                                                                                                                                                                                                                               | 结果                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `pnpm exec vitest run apps/service/src/harness/acp/policy.test.ts`（修复前）                                                                                                                                                                                                                       | 2 通过、2 失败；fetch/edit 仅永久选项错误选择 `always-reject`，预期为 `cancelled` |
| 新增 fallback Electron E2E（修复前，窗口成功启动）                                                                                                                                                                                                                                                 | 1 失败；实际按钮仅“允许一次”，缺少“拒绝”                                          |
| `pnpm exec vitest run apps/service/src/harness/acp/policy.test.ts apps/service/src/harness/acp/turn.test.ts apps/service/src/codex-chat.test.ts apps/desktop/src/main/workbench/application.test.ts apps/desktop/src/main/harness-profiles.test.ts apps/service/src/harness/codex/adapter.test.ts` | 主线程独立复跑：6 文件、113 项通过，退出 0                                        |
| `pnpm typecheck`                                                                                                                                                                                                                                                                                   | 通过，退出 0                                                                      |
| `pnpm build`                                                                                                                                                                                                                                                                                       | 通过，退出 0                                                                      |
| `pnpm exec eslint` 与 `pnpm exec prettier --check`（本轮六个源码/测试文件）                                                                                                                                                                                                                        | 最终通过，退出 0                                                                  |
| `env -u ELECTRON_RUN_AS_NODE pnpm exec playwright test e2e/harness-approvals-fallback.spec.ts e2e/harness-approvals.spec.ts --output=/private/tmp/wsl-approval-fix-20261023/e2e-final`                                                                                                             | 3 通过，退出 0（3.7 秒）；真实窗口截图已人工检查拒绝入口                          |

本轮保留的中间失败：首次受限环境未能启动 Electron；提升执行权限后旧代码复现缺失按钮。修复后的第一次窗口运行等待 window 超时，原因未判定，后续独立复跑不抹除此结果。另一次复跑已得到 `cancelled`，但测试把带作者标签的整个消息容器与正文精确比较而失败（实际为 `决定：cancelledClaude Code`）；改为段落正文精确匹配，同时增加会话 DTO 正文精确断言。新增测试初稿的空 fixture 解构触发 ESLint，已改用 `test.info()`。没有修改启动器、放宽审批结果断言或删除既有测试。

原始本机日志和截图保留在 `/private/tmp/wsl-approval-fix-20261023/`（临时证据，不作为可移植交付入口）；上表与失败原因是本次可跟踪记录。

## 旧版本 CI 与验证边界

`3553158` 的 [PR head checks #29](https://github.com/JadeSnow7/web-studio-lab/actions/runs/39844318001) 已完成：1358 项单测通过、26 跳过；175 项 Electron E2E 通过、16 跳过，checked HEAD 与候选一致。这补充了先前记录“仅本地跑 13 项 E2E”的事实，但不能替代本轮新 head 的检查。

本轮只复验受影响测试，未在本机重跑全量 Electron E2E、打包、真实 sandbox 自检或模型运行；窗口启动超时原因仍为 undetermined。用户接受与合并没有发生。最新 head 的远端 CI 状态单独记在 PR 说明中。
