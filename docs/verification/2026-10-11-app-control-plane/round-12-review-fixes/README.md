# 受管 App 控制面审查修复

本轮修复两个 P1 和两个 P2；本地交付，不提交、推送或发布。自动检查、真实执行和用户接受分别记录。

基线为 `codex/app-control-plane`、`ea3bad9e6602ccec3484cc55b247bae5815975b4` 加原有 dirty 内容。行为和验收冻结于 [SPEC](SPEC.md)。`baseline/sha256.json` 与 `baseline/source/` 保存开始时的字节；原历史证据不覆盖。

## 实现

| 项目             | 当前行为                                                                                                                        | 主要路径                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 HTTP 完成事实 | Main 派发前保存操作与任务身份；模板实例内去重、取消墓碑、1024 条不驱逐；30 秒核对未知继续阻塞，原任务可手动再核对；App 保持运行 | `apps/desktop/src/main/workbench/app-control.ts`、`application.ts`、`apps/service/src/app-service.ts`、`templates/standard-app/server/agent/operations.ts`、`routes.ts` |
| P1 CLI 清理      | 未确认或异常保留句柄、持久事实；进程和映射清理合并，派发前取消明确区分未执行                                                    | `apps/service/src/app-service.ts`、`apps/desktop/src/main/chat-service.ts`                                                                                              |
| P2 引用身份      | ref 必须带 snapshotId；成功快照在全部采集/清理完成后发布，失败取消保留原成功表；导航和 detach 失效                              | `packages/protocol/src/app-control.ts`、`apps/desktop/src/main/preview/app-ui.ts`、`apps/service/src/resource_mcp.py`                                                   |
| P2 数据完整性    | 递归稳定 JSON，保留嵌套字段与数组顺序，全部行散列，最多 20 行样本                                                               | `templates/standard-app/server/agent/data.ts`                                                                                                                           |

Main 的持久文件 `app-control/pending.json` 只存身份，不存令牌；重启恢复未知，不重放。模型退出事实单独保存在 executorState，TaskRun 与会话投影需合并 App 未确认状态。普通无 App 占用的重启仍保持原 interrupted 行为。会话区显示待确认状态，自动预算结束才提供“重新核对”；手动核对不需要活动模型 scope。若重启前模型清理未知或旧记录缺少执行器事实，App 终态只能解除 App 占用，任务仍保持清理待确认并明确提示旧模型进程未确认；本轮没有新增旧模型进程恢复机制。

审阅补齐了派发前取消、启动/停止中的读请求拒绝，以及 Main 预留 CLI 后 Service 已转为运行并通过 HTTP 完成只读请求的占用回收。只有新只读预留适用 transport 切换规则；旧 CLI 核对和数据写入仍需各自的原始完成证据。对应红测与最终 84 项组合回归见 `commands/p1-summary.json`。

## 验证记录

| 检查                   | 结果与证据                                                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 根类型、构建、单元测试 | 最终 `commands/typecheck-05.txt`、`build-05.txt`、`test-06.txt` 均退出 0；700 项 Vitest 通过、15 skipped，另 27 项 packaging 与 6 项 external-builds 通过                                                                                                                                        |
| 固定基线               | `commands/baseline-selftest-02.txt` 12/12；`fixed-baseline-check.json` 核对 14 个固定任务、参考实现、场景及 VS001 文件，无字节变化                                                                                                                                                               |
| 定向回归               | P1 120 项以及最后派发前取消 100 项组合回归；引用 20 项；MCP 2 项；模板 check 11 项、test:agent 7 项、manifest 4 项；具体命令见 `commands/`                                                                                                                                                       |
| 模板产物               | `template:verify` 与生产桥接排除通过；模板 contentSha256 为 `0dafd15059eeb670c7ae5d309ce3efe148f5a24583f7ee1179b866434542bb35`，按原生成流程更新 manifest                                                                                                                                        |
| 静态 UI 审计           | `premium-audit.json` strict 0 findings；不代替窗口验收                                                                                                                                                                                                                                           |
| Electron 全量          | 最终 `commands/e2e-all-final.txt` 退出 0：87 passed / 10 skipped / 0 failed，含三个 HTTP live、引用重排、sbx/chat/resources 相关可访问性、键盘和主题回归。首轮 82 passed / 13 skipped / 1 failed / 1 did not run 保留；harness 查询 URL 双斜杠导致 HTML 被当 JSON，修复 fixture 后定向及全量通过 |
| 真实 HTTP 取消         | 最终 `http-live-final` 三例全部通过：seed 自动核对、reset 超时 30.353 秒后手动核对、真实数据库失败终态。App 身份/PID 不变，终态前保持保护，终态后才结束取消；键盘、禁用及不抢焦点通过，cleanupErrors 均为空；见 `http-live-final-summary.json`。前轮通过证据 `http-live-03/04` 保留              |
| 真实模型固定任务       | `commands/existing-live-01.txt` 三项通过：CLI 在途取消、无模型 sandbox 控制面、真实 guest Codex 固定任务。模型 TaskRun completed；15 项 CLI 与 Main 审计一致、5 次 MCP ref+snapshotId 动作成功；Host 固定 16 步及数据库“固定验收 2026”通过，源码仅在允许范围变化；见 `model-live-summary.json`   |

最终 10 项 skipped 中的 CLI 取消、sandbox 控制面、模型固定任务已在 `existing-live-01` 单独通过；其余为未启用的其他模块 live 或 packaged 专项，不把跳过记为通过。

根 `pnpm lint` 与 `pnpm format:check` 未通过：最终 lint 2011 个错误与首轮诊断一致，格式由首轮 795 个降至 794 个文件，无新增路径；主要来自历史证据源码以及既有 `tests/vertical-slice/cdp.ts`。对照见 `preexisting-static-failures.json`。本轮增量文件的 lint、格式检查通过，未批量改写历史证据或固定基准。最初普通权限的 baseline:selftest 被 IPC 权限阻止，授权环境复跑通过。所有失败输出保留于 `commands/`。

模板和引用包先冻结失败用例，再实施修复。P1 的旧源码失败基线是在实现后用冻结副本重建，检出 10 项失败，不能宣称所有包均按时间顺序 test-first；最后派发前 CLI 取消另有实际先红后绿记录。根首轮测试中的恢复状态回归已修正；观察测试在独立及 `test-04` 全量复跑通过，但与 typecheck 和 live 并行的 `test-05` 再次出现原 5 秒预算超时；失败原样保留。live 结束后顺序执行，`observation-final` 24/24 与 `test-06` 全量通过，未修改时限或断言。

HTTP live 的准备失败也保留：`http-live-01` 在模型执行前过早运行 manifest，因尚未导入 tsx 失败；`http-live-02` 的等待点误拦模板启动测试，第一例超时，第二例由 Host 中止过时夹具，第三例未运行。受影响项目停止、清理确认，第二例进程及映射由 `host-final-cleanup.json` 独立补证。最终夹具只匹配真实 App 实例，完整 patched 模板在等待点未释放时 check 11/11 通过；等待点与终态记录、失败注入都不会作用于模板单元测试实例。

主线程查看了自动核对的真实窗口截图，以及手动核对的 960×700 最小窗口截图（请求 820 宽受产品最小宽度约束）。待确认文字、核对按钮与输入区均可见；按钮忙态已验证 disabled，结果后焦点仍为 BODY。最终截图见 `http-live-final/automatic/pending.png`、`http-live-final/manual/manual-keyboard-reconciling-narrow.png`，此前截图也保留。

真实模型、CLI 取消和无模型 sandbox 使用 `build-04`。之后仅 Service/Main 的新只读预留竞态及相应测试有 4 文件变化，模板、引用协议、固定任务未变；差异散列见 `runtime-version-boundary.json`。最终构建 `build-05` 与 `final-runtime-input-sha256.json` 绑定，并复跑完整 Electron 和 HTTP 取消三个场景。

主线程查看了模型的 `fixed-welcome-saved.png`：欢迎语卡片显示“固定验收 2026”。`product-window.png` 是 Main 窗口捕获，未包含嵌入的独立网页表面，不能作为欢迎语内容的视觉证据。

最终源码与文档清单为 `delivery-source-sha256.json`，相对本轮开始的增量为 `delivery-changes-from-start.json`。`delivery-fingerprint-verification.json` 核对最终运行输入 364 项、构建产物 6 项和固定基准 14 项无漂移；较早的 `final-source-sha256.json` 是中途捕获，保留但不作为交付版本。`commands/docs-delivery`、`format-docs-delivery`、`diff-delivery` 登记文档与 diff 的最终退出码。

## 验收边界

Host 自动操作真实窗口和独立检查不写入产品 validation，也不构成用户接受。此轮不包含安装包、发布或真人手工验收。live 测试只在新建专属项目注入后端等待点，登记后才取消，释放后仍执行真实数据库逻辑；源码 fixture 与导出独立留存。查询未知和操作失败分别记录，失败终态允许存在部分数据修改。测试专属生成项目及源码导出保留供复验；所属 App、模型、CLI 进程与端口映射均按用例核对清理，既有非本轮端口不触碰。
