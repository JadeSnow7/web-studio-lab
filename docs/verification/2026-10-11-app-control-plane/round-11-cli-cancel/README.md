# 产品界面取消真实模型在途 CLI 验证

本轮真实验证通过：通过产品“取消回复”停止真实模型的在途 CLI，核实所属进程/通道清理、后继动作未发生、已产生修改保留，并在同会话下一轮真实 CLI 调用时隔离迟到响应。过程中修复了 AI 重启切走用户会话的缺陷。用户明确授权真实模型与 sandbox live，保持权限边界，暂不提交或推送。日期：2026-10-11。

## 冻结基线

仓库 `/Users/huaodong/workspace/web-studio-lab`，origin `JadeSnow7/web-studio-lab`，分支 `codex/app-control-plane`，HEAD `ea3bad9e6602ccec3484cc55b247bae5815975b4` 加既有 dirty/untracked。354 个源码/测试输入与 round-10 最终状态逐项相同，见 [initial-source-sha256.json](initial-source-sha256.json)；原状态见 [initial-status.txt](initial-status.txt)。旧证据不改写。

权限继续使用 Codex `workspace-write`，不扩大网络、可写根或 Main scope，64 次/4 在途预算不变。仅创建本轮独立受管项目，不改固定任务、参考实现或其他项目。源码/测试改动由 coder 承担，主线程负责审查、真实运行及证据结论。

## 冻结验收

1. **真实在途**：正常 TaskRun 启动真实 guest Codex；普通命令工具执行 `wsl-app`。模型先写入允许范围的唯一标记文件并重建 manifest/实例，再调用等待不存在 testid 的 CLI 动作。取消前必须确认 Main 已收到该请求、CLI 进程及其通道仍存活。
2. **产品取消**：通过 Playwright 点击实际产品“取消回复”按钮，记录可见状态及 Main run 状态。不得用测试直接调用 cancelRun 代替被测触发。finally 救援取消必须单独记录，不可记为通过。
3. **停止与保留**：run 达到 cancelled，cleanupPending=false；任务所属 CLI、命令、Codex/helper 进程按 PID 与启动身份核对退出，私有通道删除。取消后的预置后继写文件与 CLI 动作不得发生；取消前已生成源码原字节保留。受管 App 是独立资源，取消任务后可以继续运行，验证结束再 stopApp 并核对其进程与端口映射。
4. **迟到响应**：测试启动层只观察真实 app-call 并暂存目标调用的真实 app.reply，不替代 send/cancel、不伪造工具结果。第二个正常真实 TaskRun 发出自身 CLI 请求后释放旧返回帧；旧 run 不复活，旧结果不进入新轮工具输出，新 CLI 结果须与自身 Main 审计一致。
5. **交付与回归**：保留失败轮次；核对输入散列、进程归属、截图、审计和清理。默认测试不调用模型。按实际修改执行类型、定向 lint/格式和受影响回归。产品 validation 与用户接受不由本测试修改。

## 当前状态

最初三文件改动：新增 `e2e/app-control-cancel-live.spec.ts`、新增 `e2e/fixtures/app-control-cancel-gate.ts`，以及 `e2e/helpers.ts` 的测试启动选项。输入冻结见 [source-sha256-01.json](source-sha256-01.json)，三路径增量见 [source-delta-01.json](source-delta-01.json)。前两次使用的生产源码与六项运行时/固定基准散列与 round-10 相同，见 [runtime-input-sha256.json](runtime-input-sha256.json)。

测试定向 TypeScript、ESLint、Prettier、内嵌 Python 编译、gate 转发边界检查通过，默认执行 1 skipped，均未调用模型。运行时为 Python 3.14.4、Codex CLI 0.160.0。前三次真实运行均未完整通过，原始失败记录保留；第四次完整通过，见下文。

## 首次准备未达标与重跑

`run-01` 的真实模型按原提示每 4 秒查询、最多 12 次；到第 12 次时 App 仍在重建，因此模型结束，没有发出目标 CLI 等待调用。本轮取消验收为未达到前置条件，不能记为通过，见 [early-terminal-observed.json](run-01/early-terminal-observed.json)。模型结束后 App 随后进入 running，表明查询安排不足，而非本轮观察到产品取消故障。

为停止旧测试继续等待目标，主线程核对所属 Playwright runner PID 后发送 SIGINT；运行退出 130 / 1 interrupted。中断时框架关闭 Electron 与 spec 的 finally 重叠，原 `results.json` 保留清理调用失败及退出状态尚未确认。之后独立核对产品持久状态 stopped/cleanupConfirmed=true、Host 三个所属进程均已退出、guest 项目进程为空，已写标记原值保留，后继文件不存在。补充事实见 [post-interrupt-product.json](run-01/post-interrupt-product.json)、[post-interrupt-guest.json](run-01/post-interrupt-guest.json) 与 [post-interrupt-host.txt](run-01/post-interrupt-host.txt)，不覆盖首次失败。

`run-02` 只将准备查询间隔改为 15 秒（仍最多 12 次、总等待最多 3 分钟），并在目标未出现而模型已结束时明确报错进入 finally，避免空等 10 分钟。没有修改 10 秒在途动作、8 秒触发门槛、成功/拒绝断言、64/4 预算或生产源码。第一次 spec 原字节见 [spec-attempt-01.txt](spec-attempt-01.txt)，第二次最终输入为 [source-sha256-02.json](source-sha256-02.json)。

## 第二次暴露的产品导航问题

`run-02` 已捕获真实 CLI 等待、实际持锁通道及 11 个任务所属进程，证据采集用时 3143 ms。但会话内“取消回复”按钮未能定位，30 秒后测试失败；finally 释放暂存帧并执行救援取消。因此本轮不能证明产品按钮取消。原始结果见 [results.json](run-02/results.json)、[执行日志](commands/live-02.txt)、[失败上下文](run-02/error-context.txt)，原 spec 见 [spec-attempt-02.txt](spec-attempt-02.txt)。

独立核对持久化布局，活动标签实际为“标准应用”，见 [final-navigation.json](run-02/final-navigation.json)。源码中 `restartAppForControl` 复用普通 `startApp`，后者在异步启动完成时无条件 `openResource`；这使 AI 重启自动切走用户会话，违背现有 AI 不抢焦点约定。修复应保持用户当前导航（包括等待期间的新导航），同时重建原受管 Browser 实例；用户显式启动 App 的打开行为保留。不得靠测试跳回会话掩盖此问题。

本次救援清理成功：run cancelled/cleanupPending=false，所属进程和通道已清理；App stopped/cleanupConfirmed=true、所属端口映射为空、Electron 已退出，cleanupErrors 为空。修改标记保留，后继写文件未出现。这只是失败后的清理事实，不计入按钮取消验收。

## 导航修复与回归

生产改动仅在 `apps/desktop/src/main/workbench/application.ts`：私有启动路径区分是否激活 App，AI 重启完成时使用既有 `ensureBrowser` 重建实例而不调用 `openResource`。不保存旧布局再恢复，因此不会覆盖等待期间用户的新导航。没有新 IPC、Renderer 状态、沙箱配置或权限选项。用户显式启动仍激活 App 标签。

`app-control-application.test.ts` 新增四项测试；修改生产代码前，AI 重启保留会话、保留中途导航、重建后台实例三项失败，显式启动对照通过。修复后 8/8 通过，相关 Application/managed-app 回归 44/44 通过，见 [红测](commands/restart-navigation-before.txt)、[绿测](commands/restart-navigation-after.txt)、[相关回归](commands/restart-navigation-regression.txt)。本轮精确生产补丁见 [application patch](commands/restart-navigation-application.patch)。

第三次测试另保存实际会话和取消按钮可见性、布局与活动窗格，以及点击开始/完成时间；要求实际点击在 10 秒在途等待窗口内完成，不调用 `locateSession` 返回会话掩盖问题。主线程审查后冻结 356 个源码/测试输入，见 [source-sha256-03.json](source-sha256-03.json)，相对本轮起点共五条源码/测试路径变化，见 [source-delta-03.json](source-delta-03.json)。

最终构建通过。首次默认命令沙箱不能清理既定 `/Volumes/Developer/BuildArtifacts/` 输出目录（EPERM），保留 [失败日志](commands/build.txt)；按既有外部构建配置在获准的宿主执行环境重跑 [build-authorized.txt](commands/build-authorized.txt) 退出 0。这未改变产品内 Codex 权限。只有 Main 构建散列变化，service、固定任务/场景/参考实现及依赖归档不变，见 [runtime-input-sha256-03.json](runtime-input-sha256-03.json)。

主线程独立 `pnpm test` 通过：Vitest 666 passed / 15 skipped，packaging 27 passed，external-builds 6 passed；`pnpm typecheck` 通过。见 [test.txt](commands/test.txt)、[typecheck.txt](commands/typecheck.txt)。遵循已有 DESIGN/UX 合同，不改视觉和交互入口；premium strict 静态审查 0 finding，见 [premium-audit.json](commands/premium-audit.json)，不把静态结果当作运行证据。

## 第三次：实际取消成功，界面断言引用错误

`run-03` 的 AI 重启后会话和取消按钮均保持可见，布局与活动窗格不变。目标 CLI 在途的 11 个进程及持锁通道已捕获；Playwright 点击在调用开始后 3496 ms 完成，Main 转发取消并收到 abort，目标返回真实 `cancelled`。正常取消使 TaskRun 和 conversation 都成为 cancelled，cleanupPending=false，无救援 cancelRun，见 [results.json](run-03/results.json) 与[持久化核对](run-03/post-failure-product.json)。

之后的可见文案断言错误地引用了首页 `shell/ChatMessages.tsx` 的“回复已取消，进程已退出。”；实际空间 `workspace/Session.tsx` 显示 `Codex CLI · cancelled · 沙箱由服务决定`。测试因此失败，未运行第二轮隔离；finally 释放旧响应（reason=finally-rescue）。修正只将可见断言定位到实际空间会话状态，并提前保存已核实的取消与截图；不改变产品、进程清理或迟到隔离断言。见 [失败日志](commands/live-03.txt)、[失败上下文](run-03/error-context.txt)、[原 spec](spec-attempt-03.txt)。

失败后的清理确认：11 个已捕获身份均消失、私有通道删除、保留标记原值不变、后继文件不存在；App stopped/cleanupConfirmed=true，所属映射为空、Electron 退出，cleanupErrors=[]。本次只有取消与清理的局部事实，不能记为整项通过。

## 第四次完整真实验证

`run-04` 使用与第三次相同的生产构建，只更正上述测试文案定位。最终 356 个输入见 [source-sha256-04.json](source-sha256-04.json)，构建使用 `runtime-input-sha256-03.json`。命令：`WSL_APP_CONTROL_CANCEL_LIVE=1 WSL_SBX_NAME=wsl-sbx-smoke-20261006 WSL_SBX_BIN=/opt/homebrew/bin/sbx WSL_APP_DEPENDENCY_ARCHIVE=<repo>/packaging/generated/runtime/template-dependencies.tar.gz WSL_APP_CONTROL_CANCEL_EVIDENCE=<本轮>/run-04 pnpm exec playwright test e2e/app-control-cancel-live.spec.ts`。退出 0，1 passed，4.0 分钟，见 [live-04.txt](commands/live-04.txt)。

- 正常 TaskRun `5fc7f370-9cd1-476e-bd02-24d2df48d946` 调用真实模型，在普通 `workspace-write` 命令沙箱运行 CLI。实际持锁文件通道和 11 个所属进程（helper、Codex、命令沙箱、wrapper/CLI 及 MCP 子进程）按 PID/starttime 保存。
- Playwright 在 CLI `waitFor` 开始后 3356 ms 完成实际产品按钮点击；Main 转发 cancel，service 发出 abort，Main 的真实返回和审计均为 `cancelled`。run cancelled，cleanupPending=false，界面显示 cancelled、取消按钮消失；会话布局和活动窗格保持不变。
- 已捕获的 11 个身份全部消失，私有通道删除。取消转发后旧 run 新控制调用数为 0；等待后预置的写文件及 CLI status 均未发生。模型只修改允许的保留标记及两个 agent 生成文件；45 个项目源码文件在取消后及下一轮结束后的 SHA-256 都等于取消前快照，标记原字节保留。
- 正常第二轮 `53524e0f-e606-4ce4-9011-cd2c8ff4b9cf` 在同会话发起真实 CLI `app.status` 后才释放旧帧，延迟 25434 ms，唯一 release reason 为 `second-real-request`。第二轮仅使用命令工具，status/describe 两项均退出 0、返回 ok，并逐条匹配自身 Main 审计和当前 appInstanceId；旧 run 未复活、旧审计未增加、旧结果未进入新工具输出。
- 取消任务后独立 App 仍 running；收尾显式停止后 stopped/cleanupConfirmed=true，所属映射为空，Electron 已退出，cleanupErrors=[]。`rescueGateReleased=false` 且没有 rescueCancelRun，未靠 finally 救援取得通过。

主线程核对了[原始结果](run-04/results.json)、[独立汇总](run-04/independent-summary.json)和两轮 `app-control/` 审计，并查看[取消后的真实窗口](run-04/product-after-cancel.png)与[下一轮完成窗口](run-04/product-second-completed.png)。原页面、任务和源码修改保留；旧失败结果未覆盖。

本轮取消输入由 Playwright 点击实际产品按钮，非真人鼠标/键盘；迟到帧由测试启动层暂存原始 Main 回复后释放，非伪造响应或替代模型执行。权限、租约、manifest/build 和 64/4 预算未放宽。产品 `validation=not_run`、`review=null` 保持原义，本结果不等于产品检查器已实现、用户接受或发布验收。

## 最终回归与交付

最终构建上的全量非 live `pnpm exec playwright test` 退出 0：84 passed / 10 skipped / 0 failed（3.8 分钟），含新取消 live 默认跳过及 R3 焦点通过。既有资源/会话、键盘、主题、窄窗、错误负控等均按原用例运行，见 [e2e-final.txt](commands/e2e-final.txt)。

独立 guest 只读检查确认本轮项目所属进程为空、已知通道不存在，见 [post-run-guest.json](run-04/post-run-guest.json)。项目文件保留；本轮没有停止 sandbox 或主动删除无归属映射。

针对新增 AI 重启路径，额外在最终构建上运行既有 `WSL_APP_CONTROL_LIVE=1 pnpm exec playwright test e2e/app-control-live.spec.ts`：1 passed（2.5 分钟，不调用模型）。可见产品 Browser 上的 A03 原版负控、stale→restart、固定场景连续两次通过、数据库“固定验收 2026”，以及 A07 用户接管暂停/恢复与焦点保持均通过；见 [日志](commands/visible-app-live.txt)、[结果](visible-app-live/results.json)。主线程查看了场景中的真实页面截图。

所有本轮窗口测试退出后的独立端口查询为空，见 [post-suite-ports.json](post-suite-ports.json)。测试内部的瞬时端口快照仍记录过 8081 映射，原样保留，不把那些早期快照改写成最终读数。

收尾 `check-docs`（19 个规范文件）、五个源码/测试文件及六个当前文档的定向 Prettier、`git diff --check` 均通过。最终 356 个源码/测试输入和六项构建/固定输入散列无漂移，相对本轮起点的源码增量仍仅五个路径，见 [source-delta-04.json](source-delta-04.json) 与 [final-checks.json](final-checks.json)。全树 lint/format 的历史 2011 错误、794 格式文件没有在本轮重跑，不把旧数字当作当前检查。源码、文档和可跟踪证据均留在本地工作树，暂存区为空，未提交、未推送。
