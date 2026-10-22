# W4a 执行记录 · Harness Profile、选择器与无模型自检

合同与决定见 [SPEC](SPEC.md)（§6 决定、§7 实施设计及 2026-10-22 修正）。分支 `agent/harness-profiles`，基于 `agent/harness-acp-wiring` `fa67e2e`（W0–W3b，PR #18–#23 均未合并）。本记录说明静态检查、离线测试与 fixture E2E 的结果，不代表真实 sandbox 中的多 Profile 运行、用户接受或 W4b。改动尚未提交。

## 改动

| 路径                                                                                                                                                                                           | 变化                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol/src/harness.ts`                                                                                                                                                             | 新增 Profile、自检结果、选择、本轮 Harness、可用性与 Profile 快照的 schema；`HarnessRef` 增加可选 `profileId`；`harnessRefOf` 需要 `profileId`；新增 `selectionDisplayName`、`profileDirOf`、配置目录根与环境变量表                                                                                  |
| `packages/protocol/src/chat.ts`、`ipc.ts`、`bridge.ts`、`workspace.ts`                                                                                                                         | `ChatStatus.harness` 改为 `harnesses`（每个 Harness 的可用性），新增连接层的 `SandboxStatus`；`send` 必须带 `harness`；新增 service 方法 `profile.check`；`chat:profiles-*` IPC 与 `chat.profiles` 窄接口（`window.studio` 顶层仍为 6 个键）；会话增加 `harnessSelection` 与命令 `setSessionHarness` |
| `apps/service/src/codex-chat.ts`、`harness/registry.ts`、`harness/types.ts`、`harness/codex/adapter.ts`、`harness/acp/agents.ts`、`index.ts`、`sbx.ts`                                         | 执行核心持有全部已注册 Harness，启动时逐个探测，每轮按传入的选择执行；会话身份记录所属 Harness 与 Profile，换用时开始新会话并记警告；适配器声明无模型自检；配置目录经 start 帧传入并校验；移除 `WSL_HARNESS`                                                                                         |
| `apps/service/src/guest-helper.py`                                                                                                                                                             | start 帧接受 `profileDir`：只允许声明的变量名与固定路径格式，逐级创建目录、拒绝符号链接与他人目录，只设置该变量                                                                                                                                                                                      |
| `apps/desktop/src/main/harness-profiles.ts`（新增）                                                                                                                                            | `HarnessProfileStore`：`harness-profiles.json` 的唯一写入者，串行、原子替换，内置 Profile 补齐，文件较新或无效时报错并保留原文件；`HarnessProfileService`：自检（同一 Profile 合并）、解析、启动前判断、服务首次可用时全部自检                                                                       |
| `apps/desktop/src/main/chat-service.ts`、`index.ts`、`ipc.ts`、`workbench/host.ts`、`workbench/ports.ts`、`workbench/application.ts`、`preload/index.ts`                                       | 装配 Profile 服务；`startRun` 冻结含 `profileId` 的出处、同 Profile 并发拒绝、启动路径判断可用性与登录；个人对话使用全局默认                                                                                                                                                                         |
| `apps/desktop/src/renderer/src/pages/HarnessProfiles.tsx`、`workspace/HarnessSelect.tsx`（新增）及 `SettingsPage`、`Session`、`ChatMessages`、`TitleBar`、`ConversationsPage`、`state/chat.ts` | 设置页的 Harness 可用性与 Profile 管理（自检、设为默认、删除、新建、登录命令、打开 sandbox 终端）；会话内“执行 Agent”选择；名称与版本按所选 Harness 显示                                                                                                                                             |
| `e2e/fixtures/sbx.mjs`                                                                                                                                                                         | fixture 支持 Claude Code `auth status`（目录名以 `00000000-` 开头视为未登录），relay 时按 `profileDir` 设置子进程环境                                                                                                                                                                                |
| `docs/architecture/current-runtime.md`                                                                                                                                                         | 以 Profile 与按执行选择替代 `WSL_HARNESS` 的说明                                                                                                                                                                                                                                                     |

行为变化：

- 执行服务启动时总是探测 Claude Code 的 ACP 包装器（此前只在 `WSL_HARNESS=claude-code` 时）。guest 未安装时 Claude Code 显示为不可用，Codex 不受影响。
- 每次执行记录 `harness.profileId`；同一 Profile 同时最多一个活动执行。Harness 不可用或 Profile 未登录时，执行照常创建并以明确原因失败，不换用其他 Profile。
- 同一会话换用其他 Harness 或 Profile 时不恢复旧会话身份，会话中出现一条说明。

## 验收对应

| #   | 状态         | 依据                                                                                                                                                                                                                                                                                 |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | 离线通过     | `harness-profiles.test.ts`“两个同 Harness 的 Profile 分别自检…”；`codex-chat.test.ts`“自检只返回版本与登录状态…”（已登录与未登录两个目录）                                                                                                                                           |
| P2  | 离线通过     | 自检只运行版本与登录状态命令，不调用模型；出错记为 `undetermined`（`harness-profiles.test.ts`“自检出错时记为无法判断”）                                                                                                                                                              |
| P3  | 离线通过     | fixture 的状态输出含伪造邮箱：`codex-chat.test.ts` 断言结果不含；`harness-profiles.test.ts` 断言文件只有约定字段；E2E 断言界面与 `harness-profiles.json` 均不含                                                                                                                      |
| P4  | 离线通过     | `application.test.ts` W4a 用例（冻结出处、会话选择、无效选择不留记录）；E2E 第二项                                                                                                                                                                                                   |
| P5  | 离线通过     | `application.test.ts`“…pre-launch Profile check is not logged in”；`harness-profiles.test.ts`“启动路径…”；默认选择不变                                                                                                                                                               |
| P6  | 离线通过     | `application.test.ts`“allows one active run per Profile…”                                                                                                                                                                                                                            |
| P7  | 部分         | service 侧：`codex-chat.test.ts` 拒绝变量名不符、他人目录、未注册 Harness、非内置 Profile 缺目录，均不启动进程。helper 侧：`guest-helper-mcp.test.ts` 4 项（变量名、根外路径、路径穿越、多余字段）只在 Linux 上运行，本机 macOS 跳过，**未运行**；逐级拒绝符号链接的分支没有单独用例 |
| P8  | —            | 逐项审批属于 W4b                                                                                                                                                                                                                                                                     |
| P9  | 离线通过     | `harnessDisplayName` 对没有 `profileId` 的旧记录仍按旧出处显示；`HarnessRefSchema` 的 `profileId` 为可选                                                                                                                                                                             |
| P10 | 通过         | 下表全量单元测试与 Electron E2E                                                                                                                                                                                                                                                      |
| P11 | 真实运行通过 | 见文末“真实运行：P11 两个 Claude Code Profile”（2026-10-22，同一账号登录两个目录）                                                                                                                                                                                                   |

## 测试调整（语义确实改变的才改）

- W2 的“runtime 未报告时省略 Harness”删除：W4a 起每次执行都解析出 Harness 与 Profile。改为 5 个 W4a 用例。
- W2 的“冻结 HarnessRef”改用 `resolveHarness`，并断言同一份本轮参数传给 `send`。
- ACP 用例原断言顶层 `available`/`version` 表示“本服务唯一的 Harness”；顶层改为 sandbox 连接本身后，改读 `harnesses[]` 中该 Harness 的可用性与版本。“Agent 不可启动”用例中顶层 `available` 由 `false` 变为 `true`（sandbox 可用，Claude Code 不可用）。
- `index.test.ts` 的“排队发送不启动 guest 进程”：启动时探测 ACP Harness 也会启动 guest 进程，初始化完成后清空计数，只断言请求之后启动的进程。
- `resource-dispatch.test.ts`：不带 `harness` 的发送现在应被拒绝，原 `true` 改为 `false`，另加带 `harness` 时通过的断言。
- 其余为补齐新必填字段（`harnesses: []`、`harness`、Profile 服务构造参数）的测试数据，以及 13 个测试替身统一使用 `harness-test-fixture.ts`。

## 实际运行（2026-10-22，macOS）

环境：macOS 26.6.2 arm64，Node v26.5.0（产品期望 Node 24，按实际记录），pnpm 10.34.6，Python 3.15.0，Electron 44.5.1。基线与被测代码为本工作树当前未提交改动。

| 命令                                                                          | 结果                                                                              |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                              | 通过                                                                              |
| `pnpm exec eslint apps packages e2e scripts templates/standard-app`           | 通过                                                                              |
| `pnpm exec prettier --check apps packages e2e scripts templates/standard-app` | 通过                                                                              |
| `node scripts/check-docs.mjs`                                                 | 通过                                                                              |
| `pnpm exec vitest run`（最终）                                                | 1349 通过、26 跳过、0 失败                                                        |
| `pnpm build`                                                                  | 通过                                                                              |
| `env -u ELECTRON_RUN_AS_NODE pnpm exec playwright test`（最终）               | 173 通过、16 跳过、0 失败（5.1 分钟），含新增 `e2e/harness-profiles.spec.ts` 2 项 |

过程中的失败，按发生顺序保留：

1. 第一次全量 E2E 在约 60 项后手动停止：设置页组件的选择器每次返回新的空数组，订阅无限重渲染（React #185），设置页常驻挂载，几乎所有用例的渲染进程崩溃；关闭流程用例因此停在真实的退出确认框上。修正为选择器返回原引用、默认值放在订阅之外。单元测试未覆盖组件渲染，没有发现这个问题。
2. 第二次全量 E2E：168 通过、5 失败。其中 4 项因为初稿在 Harness 不可用时直接拒绝 `startRun`、不创建执行，违反既有约定“执行器不可用时保留草稿并记录失败运行”；已按 SPEC §7 第 7 条的修正改为在启动路径上失败。另 1 项 `status-surface.spec.ts:2000` 的焦点断言为 `inactive`，第三次全量中通过，判断为窗口焦点的偶发问题。
3. 单元测试中 `harness-profiles.test.ts`“执行服务第一次可用时…”在一次全量运行中失败（耗时 1ms），错误文本未保存；随后 7 次全量运行均通过，当时原因未定位。2026-10-22 W4b 期间再次出现并保存了错误：`ENOTEMPTY: directory not empty, rmdir …/wsl-profiles-*`。原因在测试本身：`onStatus` 在后台启动的自检完成后会写入文件，用例只等到 `checkProfile` 被调用两次就结束，`afterEach` 删除临时目录时偶尔与写入竞争。产品行为不受影响；修正为等待两个自检结果都已写入后再结束（随 W4b 提交），之后 Main 单元测试连续 3 次通过。
4. 其他运行中出现过的 `setup-adapter.test.ts` sbx inspect 5 秒超时，`origin/main` 上同样出现，与本包无关；最终一次全量未出现。

## 未运行与已知限制

- P11 真实运行、W4-2 的 `CODEX_HOME` 实测（是否能绕开 sbx secret 选择另一个 Codex 账号）：需要用户在场登录。
- helper 的 `profileDir` 用例只在 Linux 运行；打包后的 E2E 未运行。
- guest 环境预设了 `CODEX_HOME`（值未读取）；内置 `codex:default` 沿用它，helper 只在带 `profileDir` 时覆盖。
- `claude-agent-acp --cli auth status` 会在配置目录内写入 `.claude.json`；自检因此不是完全只读。
- 删除 Profile 不删除 guest 内的配置目录与登录数据（删除数据需另行授权）。
- 个人对话的消息作者按当前全局默认显示；默认在对话中途改变时，旧消息的显示名随之改变。
- 打包安装器的 guest 载荷仍只有 Codex，打包版中 Claude Code 会显示为不可用（交接已知缺口）。
- W4b（逐项审批）未开始。

## W4b 执行记录 · 逐项审批

设计见 [SPEC](SPEC.md) §8。分支 `agent/harness-approvals`，基于 `agent/harness-profiles` `c1aee7d`（W4a，PR #25）。改动尚未提交。

### 改动

| 路径                                                                                                                                          | 变化                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/protocol/src/chat.ts`、`ipc.ts`、`bridge.ts`、`workspace.ts`                                                                        | 会话快照增加可选的 `permissionRequests`（请求身份、所属轮次、工具标题与类型、一次性选项、截止时间）；service 方法 `permission.reply`；个人对话 IPC `chat:permission-reply` 与 `chat.answerPermission`；工作台命令 `answerPermission` |
| `apps/service/src/harness/acp/policy.ts`                                                                                                      | `workspaceWritePolicy` 改为 `approvalPolicy`：允许类型照旧自动放行一次；`fetch`、`switch_mode` 与未知类型交给用户，只保留一次性选项；没有一次性允许选项时照旧拒绝                                                                    |
| `apps/service/src/harness/acp/turn.ts`                                                                                                        | 权限请求只带 `toolCallId` 时，用本轮已知的工具标题与类型补齐                                                                                                                                                                         |
| `apps/service/src/codex-chat.ts`、`index.ts`                                                                                                  | 待决请求写入快照并等待回复；10 分钟超时按拒绝处理；轮次失败、取消、结束时以 cancelled 收尾；回复只接受当前轮次仍待决的请求与其一次性选项；每个决定记入会话警告                                                                       |
| `apps/desktop/src/main/workbench/application.ts`、`ports.ts`、`host.ts`、`chat-service.ts`、`ipc.ts`、`preload/index.ts`                      | Main 核对会话、当前执行与请求仍待决后转发；不改写本地状态，决定由执行服务的新快照发布                                                                                                                                                |
| `apps/desktop/src/renderer/src/components/PermissionRequests.tsx`（新增）、`workspace/Session.tsx`、`shell/ChatMessages.tsx`、`state/chat.ts` | 空间会话与个人对话中的审批卡片，只在对应轮次运行时显示                                                                                                                                                                               |
| `apps/service/src/fixtures/fake-acp-agent.mjs`、`e2e/fixtures/sbx.mjs`、`e2e/helpers.ts`                                                      | 假 ACP Agent 的 `ask` 场景（fetch 权限，含“始终允许”选项）；fixture sbx 只在 `WSL_FIXTURE_ACP_SCENARIO` 存在时把 `claude-agent-acp` 换成假 Agent                                                                                     |
| `apps/desktop/src/main/harness-profiles.test.ts`                                                                                              | 修正 W4a 中“执行服务第一次可用时…”的临时目录竞争（见上文“过程中的失败”第 3 条）                                                                                                                                                      |

行为变化：Claude Code 的 `fetch`、`switch_mode` 与未知类型权限请求不再直接拒绝，而是等待用户决定；Codex native 不变。

### 验收对应（P8）

| 路径       | 依据                                                                                                                                                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 允许       | `codex-chat.test.ts` W4b“原先拒绝的 fetch 交给用户…”；E2E 两项（个人对话、空间会话）                                                                                                                                                               |
| 拒绝       | `codex-chat.test.ts`“用户拒绝”；E2E 个人对话                                                                                                                                                                                                       |
| 超时       | `codex-chat.test.ts`“截止时间前无人回复时按拒绝处理”（时限缩短到 200ms）                                                                                                                                                                           |
| 执行取消   | `codex-chat.test.ts`“等待审批时取消执行…迟到的回复不产生决定”                                                                                                                                                                                      |
| 伪造或过期 | `codex-chat.test.ts`“伪造的请求身份不能产生决定”、允许后重复回复被拒绝、“始终允许”的选项身份被拒绝；`application.test.ts`“forwards a permission reply only for a pending request…”（未知请求、非本请求选项不转发，service 报错时以 conflict 返回） |

### 实际运行（2026-10-22，macOS，环境同上）

| 命令                                                    | 结果                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`、维护目录 ESLint、`check-docs`         | 通过                                                                                                                                                                                                                                                                                                                                                                                        |
| 维护目录 Prettier                                       | **原记录为“通过”，有误**：W4b 期间只对部分文件运行了 `prettier --write`，没有对维护目录运行 `--check`。提交 `fe3684f` 中 `apps/service/src/fixtures/fake-acp-agent.mjs`、`apps/service/src/harness/acp/turn.ts`、`packages/protocol/src/chat.ts` 未按 Prettier 格式化（W4a 的 `c1aee7d` 中这三个文件已格式化）。2026-10-22 在后续提交中只做格式化修正，之后维护目录 `prettier --check` 通过 |
| `pnpm exec vitest run`                                  | 第一次 1354 通过、1 失败、26 跳过（上述临时目录竞争）；修正后 `apps/desktop/src/main` 连续 3 次 595 通过，完整复跑 1355 通过、26 跳过、0 失败                                                                                                                                                                                                                                               |
| `pnpm build`                                            | 通过                                                                                                                                                                                                                                                                                                                                                                                        |
| `env -u ELECTRON_RUN_AS_NODE pnpm exec playwright test` | 175 通过、16 跳过、0 失败（4.7 分钟），含新增 `e2e/harness-approvals.spec.ts` 2 项                                                                                                                                                                                                                                                                                                          |

### 真实运行：Claude Code 的 fetch 审批（2026-10-22）

运行条件：Lab 以 `pnpm dev` 从独立 worktree 启动（detached `fe3684f`，与主 checkout 隔离：当时另一个会话把主 checkout 切到 `agent/simplify-ops` 并在其中运行 E2E）；sandbox `wsl-sbx-smoke-20261006`；Claude Code `0.94.0`（ACP），Profile `claude-code:default`（R8 中的登录）。用户的个人数据目录与之前相同。没有新增网络放行或 Profile 登录。

请求原文（两轮相同）：

> 请用你的网页获取工具（不要用 shell 命令）读取 https://registry.npmjs.org/@agentclientprotocol%2fclaude-agent-acp ，告诉我 dist-tags.latest 的值。

**代操作 UI 观察证据**（界面由 Codex 代为操作，读取 Lab 窗口的可访问性文本与截图后由用户转述；未附截图，本记录未独立读取；个人对话的消息只在本次运行的服务内存中，不写入磁盘）：

1. 设置页：Claude Code `0.94.0` 为“可用”，“Claude Code · 默认”为“已登录”；点击“设为默认”。
2. 两轮都出现“Agent 请求权限：Fetch https://registry.npmjs.org/@agentclientprotocol%2fclaude-agent-acp”，类型 `fetch`；卡片只有“允许一次”“拒绝”两个按钮，并写明截止前未回复按拒绝处理、只对这一次有效。
3. 第一轮点“拒绝”：会话警告“已拒绝 Fetch https://registry.npmjs.org/@agentclientprotocol%2fclaude-agent-acp 的权限请求（用户）”；Agent 回复权限被拒绝、没有拿到 `dist-tags.latest`，并按要求没有改用 `curl` 或 `npm view`。
4. 第二轮点“允许一次”：会话警告“已允许 Fetch https://registry.npmjs.org/@agentclientprotocol%2fclaude-agent-acp（用户，一次）”；Agent 回复 `dist-tags.latest = 0.94.0`、`preview = 0.94.1-preview.4`。
5. “工具执行 · 3 条”：`acp:other ToolSearch`（Tool: WebFetch，退出码 0）；第一次 `acp:fetch` 结果为 “User refused permission to run tool”，退出码 1；第二次 `acp:fetch` 返回 latest `0.94.0`，退出码 0。没有 shell 调用。
6. 同时出现会话警告“ACP 未识别的通知：_auth/status_update”（R8 中已见）。

**独立读取的证据**（本 Agent 直接读取 `sbx policy log wsl-sbx-smoke-20261006`，22:12 读取）：

| 方向 | 主机                                     | 代理           | 最后时间（CST） | 次数 |
| ---- | ---------------------------------------- | -------------- | --------------- | ---- |
| 放行 | `registry.npmjs.org:443`                 | forward-bypass | 22:10:26        | 1    |
| 放行 | `api.anthropic.com:443`                  | forward-bypass | 22:10:36        | 49   |
| 拦截 | `http-intake.logs.us5.datadoghq.com:443` | forward        | 22:10:36        | 5    |
| 拦截 | `mcp-proxy.anthropic.com:443`            | forward        | 22:09:09        | 2    |

`registry.npmjs.org` 只有一次访问，与“拒绝的一轮没有访问、允许的一轮访问一次”一致；日志不记录请求属于哪一轮，这一对应关系依据的是上面的 UI 观察。被拦截的两项是 Claude Code 的遥测上报与远程 MCP 代理，与本次验证无关，未放行。

结论限定为：在本 sandbox、`fe3684f` 与默认 Profile 下，Claude Code 的一次真实 `fetch` 权限请求按 W4b 交给用户，拒绝与允许都送达 Agent 并记入会话；UI 部分为代操作观察，网络部分为独立读取。不代表独立验收通过或用户接受。

### 真实运行：P11 两个 Claude Code Profile（2026-10-22）

运行条件同上（独立 worktree、`fe3684f`、sandbox `wsl-sbx-smoke-20261006`、Claude Code `0.94.0`）。界面操作与登录由用户完成；以下除注明外均为本 Agent 独立读取的 `harness-profiles.json`、`workbench.json` 与 guest 文件名、时间戳（未读取凭据内容）。

1. **新建**：第一次新建的 Profile 未出现在本 Lab 的 `harness-profiles.json`（文件停在 22:08 设置默认时）。当时另一个会话的 E2E 也在运行，其 Electron 与本 Lab 的 bundle 标识相同，判断为在 E2E 实例的窗口中新建（临时数据目录，已随实例关闭）。用户在唯一的 Lab 窗口重新新建后写入：`99200dfd-fe0a-4c31-88be-9ae6dbb8bc2b`，标签“P11 第二账号”，目录 `/home/agent/.wsl-profiles/claude-code/99200dfd-…`，14:48:06Z 自检 `logged_out`。
2. **目录**：guest 中 `.wsl-profiles`、`claude-code` 与该目录逐级为 `drwx------ agent`，树内没有符号链接；登录前只有自检写入的 `.claude.json`、`.claude.json.lock`、`backups`。
3. **登录**：用户在 sandbox 终端执行 `CLAUDE_CONFIG_DIR=<该目录> claude-agent-acp --cli auth login --claudeai`，登录的是与默认 Profile **相同**的 Claude 账号（用户告知）。该目录的 `.credentials.json` 写于 14:56:37Z；默认 `~/.claude/.credentials.json` 的时间仍为 06:47Z（R8 登录），未被改动。用户报告自检显示“已登录”，但文件中该 Profile 的自检在登录后仍停在 14:48:06Z 的 `logged_out`，以文件为准。
4. **两次运行**（同一空间会话，依次选择两个 Profile）：

|                  | 默认 Profile                                             | P11 Profile                                                                       |
| ---------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| runId            | `8abcbe8e-2e37-42e0-b4f6-1586a1123e40`                   | `131146cc-a5d9-4286-965e-6ae89973caaf`                                            |
| 冻结的 `harness` | `claude-code` / `acp` / `0.94.0` / `claude-code:default` | `claude-code` / `acp` / `0.94.0` / `99200dfd-…`                                   |
| 时间（UTC）      | 15:21:12 → 15:21:28                                      | 15:21:54 → 15:22:14                                                               |
| 结果             | `completed`，回复“收到”，0 次工具调用，清理已确认        | 同左                                                                              |
| Agent 会话身份   | `e0d618e2-716f-40b7-82f6-f8acd9346c75`                   | `1171e797-b03f-4f89-ab14-7da61da278bc`                                            |
| 会话警告         | `ACP 未识别的通知：_auth/status_update`                  | “本轮改用 Claude Code（99200dfd-…），已开始新的 Agent 会话；之前的上下文不会带入” |

5. **启动前重新自检**：P11 Profile 的自检结果在 15:22:01Z 变为 `logged_in`，晚于其执行开始的 15:21:54Z，即启动路径因上次不是已登录而重新自检后才继续。
6. **目录隔离**：会话文件 `projects/-home-agent-workspace/e0d618e2-….jsonl` 只在 `~/.claude` 下，`…/1171e797-….jsonl` 只在 P11 Profile 目录下，互不出现在对方目录中。

结论限定为：同一 Claude 账号登录到两个配置目录时，两个 Profile 的自检、执行出处、会话文件与凭据文件各自独立；未验证两个不同账号的配额或计费隔离。

### 真实运行中发现的缺陷

- **Codex 内置 Profile 的自检总是 `undetermined`**：guest 中 `codex login status` 把结果写到 **stderr**（已登录“Logged in using an API key - \*\*\*”退出 0；空 `CODEX_HOME` 为“Not logged in”退出 1），stdout 为空；自检只收集 stdout，因此记为“无法从登录状态命令判断（退出码 0）”。Codex 为默认选择时，执行会在启动路径上以“无法判断登录状态”失败。fixture sbx 把 Codex 的登录状态写在 stdout，与真实 CLI 不一致，所以单元测试与 E2E 没有发现。W4a 实测表中的说明也有误：当时用 `2>&1` 合并了输出。已修复（2026-10-22，W4b 分支上的后续提交）：自检分别收集 stdout 与 stderr，`ProfileSelfCheck.parseStatus` 同时接收两者；Codex 的解析两个流都看，“Logged in”与“Not logged in”同时出现时为 `undetermined`；fixture sbx 改为把 Codex 登录状态写在 stderr。去掉执行核心的 stderr 收集时 `codex-chat.test.ts`“自检只返回版本与登录状态…”失败，恢复后通过；`adapter.test.ts` 新增 3 项解析用例。修复后未在真实 sandbox 中重新自检。

### 真实运行：W4-2 `CODEX_HOME` 实测（2026-10-22）

问题：sandbox 已有 global 的 sbx `openai` secret 时，在同一 sandbox 内用另一个 `CODEX_HOME` 登录另一个 OpenAI 账号，Codex 执行用的是哪个账号。以下均为本 Agent 在 guest 内直接运行与读取（输出中的邮箱、令牌已遮蔽；只读取 rollout 中的限额字段与错误事件，未读取对话内容与凭据）；账号 B 的登录由用户完成。

| 项                                                    | 默认 `CODEX_HOME`（sbx secret，账号 A）                      | `/home/agent/w42-codex-home`（用户以 `codex login --device-auth` 登录的另一个账号 B）                                     |
| ----------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `codex login status`（stderr）                        | Logged in using an API key - \*\*\*                          | Logged in using ChatGPT                                                                                                   |
| 最小执行（`codex exec --sandbox read-only`）          | 两次成功，回复与要求一致                                     | 失败（退出 1），无回复；rollout 的 `task_complete` 错误为 `selected workspace missing from routing discovery`（约 24 秒） |
| 服务端返回的限额（rollout `token_count.rate_limits`） | 周窗口 `used_percent 84.0`、`resets_at 1793106001`，两次相同 | 无（执行未完成）                                                                                                          |
| 网络路径（`sbx policy log`）                          | `chatgpt.com:443` 经 `forward`                               | 同样经 `forward`；登录时 `auth.openai.com:443` 经 `forward` 一次                                                          |

对照：没有配置 sbx secret 的 `api.anthropic.com` 一律经 `forward-bypass`。即 sbx 对持有 service secret 的服务走中间代理（可注入凭据的路径）。

结论：

- 确认：在持有 global `openai` secret 的 sandbox 中，用另一个 `CODEX_HOME` 登录另一个账号**不能**让 Codex 正常执行。
- 与证据一致但未证实：代理以 sbx secret 替换认证，而 Codex 仍按账号 B 的 `auth.json` 发送工作区身份，服务端无法对应；另一种可能是账号 B 本身没有可用的 Codex 工作区。区分两者需要在 sbx 之外使用账号 B，不在本次范围。
- 对 W4-2 的意义：维持 B（Codex 在 sbx 中只有内置的“sbx 默认”Profile）。sbx 文档说明 service secret 可用 `--sandbox` 限定到单个 sandbox，因此多个 Codex 账号的可行做法是一个 sandbox 一个账号，需另立合同。

测试目录 `/home/agent/w42-codex-home` 现含账号 B 的登录数据（`auth.json`），不属于 Lab 管理的 Profile；是否删除由用户决定。
