# Codex 命令沙箱中的 wsl-app CLI 修复与验证

本轮目标是在既有 `workspace-write` 权限边界内打通 CLI，不改变网络策略、可写根、Main 授权、实例租约或审计。用户明确授权修复与真实模型验证，暂不提交或推送。日期：2026-10-11（Asia/Shanghai）。

## 基线与根因

仓库 `/Users/huaodong/workspace/web-studio-lab`，分支 `codex/app-control-plane`，HEAD `ea3bad9e6602ccec3484cc55b247bae5815975b4` 加既有 dirty/untracked。初始状态见 [initial-status.txt](initial-status.txt)，353 个源码、模板及测试的初始散列见 [initial-source-sha256.json](initial-source-sha256.json)。相关源码原字节另存为本目录的 `*.before.txt`；round-01 至 round-09 保持历史含义。

round-09 真实模型执行 `wsl-app describe` 返回退出 3 / `transport_unavailable`，而真实 MCP 成功。本轮在同一 guest、Codex CLI 0.160.0 下无模型重现：外部进程可连接私有 Unix socket；`codex sandbox -c 'sandbox_mode="workspace-write"' -- python3 …` 内对同一 socket 的连接返回 `PermissionError / EPERM`。同一进程可读写私有 `/tmp` 文件并取得 `flock`；写入 `/home/agent` 下本轮自建探针被 `EROFS` 拒绝，探针原值不变。临时探针均清理，见 [sandbox-transport-probe.json](sandbox-transport-probe.json)。

最初尝试旧语法 `codex sandbox linux --help` 时，当前版本把 `linux` 当作待执行命令而失败；随后读取实际 `codex sandbox --help` 并使用上述语法。未调用模型、读取认证文件或改变 Codex 配置。

排查时参考 [OpenAI 官方 sandbox 说明](https://learn.chatgpt.com/docs/sandboxing)：命令继承沙箱的文件和网络限制，审批与沙箱边界是不同控制。本机 CLI 版本的具体行为以上述探针为准，不从最新文档推断当前版本支持某个例外配置。

## 冻结修复约定

- CLI 显式使用每轮私有临时目录内的四槽文件 IPC；MCP 保留 Unix socket。CLI 不在失败后自动回退、不重试或重放副作用。
- 文件通道只承载现有 `app.*` 白名单及有界 JSON；请求 16 KiB、响应 1 MiB、60 秒截止。MCP 与 CLI 共用每轮 64 次与 4 个在途预算。
- 槽位由 helper 创建，文件锁表示调用存活，UUID 绑定请求和响应；调用进程死亡、超时或轮次结束时向既有取消链传播。迟到结果不能进入另一请求。
- 通过固定槽位、dirfd、`O_NOFOLLOW` 和文件类型核对拒绝符号链接及非普通文件，不开放任意路径代理。
- 继续使用原 `observation-call/result/cancel` 帧和 Main dispatcher。活动 run、实例、文档代次、暂停与 reset 授权规则保持不变；不启用网络、不额外扩大可写根或取消沙箱。

## 验收与执行状态

实现和单测由 coder 负责，主线程已审查实际 diff，并执行真实 Linux guest、构建与全量单测。冻结的验收如下：

1. 同一 CLI 正常请求经真实文件通道返回；坏 JSON、未知工具、超大消息、符号链接拒绝，无后端副作用。
2. 四槽并发与共享总预算不超限；客户端退出、超时、helper 清理和迟到响应均有可辨别结果。
3. 真实 Codex `workspace-write` 内 CLI describe/UI/state/query 成功，旧实例和未授权 reset 被 Main 拒绝；真实 MCP 和 Host 独立固定 16 步仍通过。
4. 本轮新建项目的进程、端口映射和每轮通道清理确认；固定基准、其他项目和继承的映射保持不变。
5. 类型、定向 lint/格式、构建、受影响单测与窗口回归；旧 lint/格式基线不改写。

文件 IPC 是适配已有受管控制能力的传输层，不是通用网络代理或新的权限权威。同 UID guest 进程间的既有边界不升级为强隔离；产品 validation 与用户接受仍由原流程管理。

## 已执行检查

改动恰为 7 个源码/测试路径，见 [source-delta-02.json](source-delta-02.json)：service 的 `guest-helper.py`、`resource_mcp.py`，CLI/MCP 测试 `app_control_mcp_tests.py`、`app-control-mcp.test.ts`、新增 `app_cli_transport_tests.py`，既有 parser 测试 `observation_mcp_tests.py`（只补新通道上下文），以及 `e2e/app-control-model-live.spec.ts`。最终 354 个输入散列见 [final-source-sha256-02.json](final-source-sha256-02.json)，构建与固定基准散列见 [runtime-input-sha256.json](runtime-input-sha256.json)。Main、协议、模板及 Codex sandbox 参数未修改。

- 真正的 `codex sandbox` 下文件通道往返成功：见 [sandbox-cli-after.json](sandbox-cli-after.json)。此检查使用合成 Main 响应，只证明沙箱内传输可行，不等于模型或产品验收。
- 真实 Linux guest 的 14 个 Python 测试通过（新增 CLI 11 个与既有 MCP 3 个），见 [guest-python-tests.txt](commands/guest-python-tests.txt)。覆盖四槽、共享预算、真实子进程退出、双端截止、迟到响应、非法输入、符号链接/FIFO/硬链接及清理失败。既有 5 个观察/parser 测试在本机回归通过。
- `pnpm typecheck` 与 `pnpm build` 退出 0。`pnpm test` 独立重跑为 Vitest 662 passed / 15 skipped，packaging 27 passed、external-builds 6 passed。
- 首次全量测试与构建并行时，未改动的 `observation-application.test.ts` 64 次预算用例超过 5000 ms，结果 661 passed / 1 failed；原日志 `commands/test.txt` 保留。构建结束后运行相同命令全部通过，见 `commands/test-isolated.txt`；没有更改超时、断言或该源码。
- 定向 ESLint、Prettier、Python 编译通过；新增 live 断言默认运行仍为 1 skipped。真实模型和窗口回归结果见下文。

## 真实模型的两次验证

同一 sandbox 内分别创建独立临时产品项目，每次正常 TaskRun 最多 10 分钟。命令均为 `WSL_APP_CONTROL_MODEL_LIVE=1 WSL_SBX_NAME=wsl-sbx-smoke-20261006 WSL_SBX_BIN=/opt/homebrew/bin/sbx WSL_APP_DEPENDENCY_ARCHIVE=<repo>/packaging/generated/runtime/template-dependencies.tar.gz WSL_APP_CONTROL_MODEL_EVIDENCE=<本轮>/model-live-0N pnpm exec playwright test e2e/app-control-model-live.spec.ts`，使用 pnpm 10.34.6。固定任务、场景与运行时构建在两次之间完全相同。

第一次 [model-live-01](model-live-01/results.json) 失败，原日志 `commands/model-live-01.txt` 保留。模型先经 MCP 自验，耗尽共享 64 次预算；随后第一个 CLI describe 经新通道收到 `run control-plane budget exhausted`，退出 3。此轮不是 socket EPERM，但仍不能计为 CLI 通过；Host 固定场景未运行。进程与映射清理已确认，私有通道删除见 [channels-after-attempt-01.json](channels-after-attempt-01.json)。

第二次只调整测试的模型提示顺序：先在稳定模板上完成 11 项 CLI 验证，再实现欢迎语任务；要求 MCP 自计数、重启后间隔查询。测试脚本、所有成功和拒绝断言、生产实现以及 64/4 预算均未改变。第一次输入散列 `final-source-sha256.json` 与提示源码 `model-live.spec.ts.attempt-01.txt` 保留，第二次输入为 `final-source-sha256-02.json`。CLI 成功项必须退出 0，两项拒绝必须退出 1，并逐项匹配独立 Main 审计中的 run、工具、原始参数散列与结果；拒绝前后公开状态和数据库记录必须一致。

第二次 [model-live-02/results.json](model-live-02/results.json) 通过（Playwright 1 passed，5.4 分钟），run `7e66125e-e338-409a-a2d3-ff4829a75b5e`：

- CLI 11 次：describe、status、snapshot、点击、等待、state/query 及拒绝后的复读成功；伪造实例返回 `stale_instance`，未授权 reset 返回 `authorization_required`。9 次成功退出 0，2 次预期拒绝退出 1；11 条独立 Main 审计均匹配。
- MCP 24 次与 CLI 11 次合计 35 次 Main 审计，33 个 `ok` 和上述两项拒绝，未触及 64 次预算；模型实际使用 click/type/navigate，自验命令 `npm run check` 和 `npm run agent:check` 均退出 0。
- 新建 guest 项目只修改 `src/App.tsx`、`agent/AGENTS.md` 和 `agent/app.manifest.json`，符合冻结范围。模型是否完整理解自验不从工具存在推断，保留 `modelFullSelfVerification=not_proven_by_tool_presence`。
- 独立 Host [固定轨迹](model-live-02/host-fixed-trace.json) 16 步全部通过，数据库查询结果为 `固定验收 2026`。主线程查看了[真实页面截图](model-live-02/fixed-welcome-saved.png)，欢迎语卡片、输入框和保存值均可见；`product-window.png` 的原生网页区域不能代替此页面截图。
- 最终实例 `stopped`、`cleanupConfirmed=true`，guest 所属进程为空、所属映射为空、Electron 已退出，`cleanupErrors=[]`。运行中的私有通道与退出后的删除核对见 [observed-channels-active-02.json](observed-channels-active-02.json)、[channels-after-attempt-02.json](channels-after-attempt-02.json)。既有 8081 映射不属于动态端口实例，本轮未删除。
- 固定任务、场景、参考实现和依赖归档散列未变。实际 Codex 仍为 `exec --sandbox workspace-write`，未额外授权网络、目录或 reset；MCP 和 CLI 仍共享原 Main 权威。

本轮打通 CLI 的正常调用与两项权限拒绝。命令进程退出/截止的取消传播由真实 Linux Python 子进程和 helper 路由测试覆盖；尚未把真人取消整个模型任务时的在途 CLI 副作用做产品 live 验收。真人鼠标/键盘输入未测。Host 结果不写入产品检查器，TaskRun `validation=not_run`、`review=null`，不等于用户接受或完整产品验收。

原始命令输出另存为 `commands/*.txt`，与本机 `.log` 字节相同，供 Git 跟踪；未改写失败输出。全树 lint/format 未在本轮重跑，历史 2011 个 lint 错误与 794 个格式文件只作为旧基线引用；本轮所改 TS 与文档已做定向检查。

## 最终回归与交付

`pnpm exec playwright test` 在最终构建上退出 0：84 passed / 9 skipped / 0 failed（3.6 分钟），包括此前出现系统焦点失败的 R3 用例；默认 live 用例仍跳过。原始输出见 [e2e-final.txt](commands/e2e-final.txt)。无修改断言、放宽超时或更改固定基准来取得通过。

`node scripts/check-docs.mjs`、定向文档 Prettier 与 `git diff --check` 均通过。收尾核对 354 个源码/测试输入及 6 个构建/固定基准输入散列无漂移；源码增量仍仅 7 个路径。源码、文档与可跟踪证据均留在本地未提交工作树，暂存区为空，未提交或推送。命令汇总与身份核对见 [final-checks.json](final-checks.json)。
