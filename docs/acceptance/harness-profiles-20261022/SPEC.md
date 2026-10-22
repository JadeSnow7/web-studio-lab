# W4 · Harness Profile、选择器与逐项审批

状态：**2026-10-22 用户采纳 §6 全部建议（W4-1 至 W4-12），按 W4a → W4b 实施**。来源：[多 Harness 协作设计](../../design/2026-10-21-multi-harness-collaboration.md) §5（Profile）、§9（审批）、§11（界面），[实施计划](../../plans/2026-10-21-multi-harness-collaboration.md) W4，以及 2026-10-22 交接对 W4 的范围说明。基线：`agent/harness-acp-wiring` `fa67e2e`（W0–W3b，对应 PR #18–#23，均未合并）。上述设计与计划位于 W1（`agent/adr-0003-scope`），W1 合并前链接不可用。

## 1. 现状事实（2026-10-22 静态读取与只读探查）

| 方面              | 事实                                                                                                                                                                                                                                       | 出处                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Harness 选择      | service 启动时按环境变量 `WSL_HARNESS` 选一次，整个 `CodexChat` 共用；不能按会话或执行选择                                                                                                                                                 | `apps/service/src/index.ts`、`apps/service/src/harness/registry.ts`                             |
| 出处冻结          | `startRun` 冻结 `runtime.currentHarness()`（service 级单值）为 `HarnessRef`；`HarnessRef` 没有 `profileId`                                                                                                                                 | `apps/desktop/src/main/workbench/application.ts` `startRun`、`packages/protocol/src/harness.ts` |
| 审批              | ACP 权限请求由 `workspaceWritePolicy` 自动处理：工作区内读、写、删、移动、搜索、执行、思考、其他放行一次；`fetch`、`switch_mode`、未知类型拒绝并记警告。Codex native 以 `workspace-write` 运行，没有逐项审批                               | `apps/service/src/harness/acp/policy.ts`                                                        |
| 子进程环境        | guest helper 以 `os.environ` 为子进程环境，只追加 PATH、TERM、观察通道；start 帧没有按执行传入环境变量的字段                                                                                                                               | `apps/service/src/guest-helper.py`                                                              |
| Profile 预留      | 只有 `AcpAgentSpec.configDirEnv = 'CLAUDE_CONFIG_DIR'` 一处声明，未被使用；代码中没有 `CODEX_HOME`                                                                                                                                         | `apps/service/src/harness/acp/agents.ts`                                                        |
| 写入并发          | W0 的 guest 写入许可：同一时刻整个 sandbox 只允许一个会话的轮次写入，Lane（W5）前全局并发实际为 1                                                                                                                                          | `apps/desktop/src/main/workbench/guest-write-lease.ts`                                          |
| Codex 认证（sbx） | sbx 有 **global** 的 service secret `openai`；sbx 说明为“sandbox 启动时由代理代为认证 API 请求，secret 不直接暴露”。guest 内另有 `~/.codex/auth.json`（未读取内容）。在 sbx 里 Codex 账号由谁决定、`CODEX_HOME` 能否另选账号，**尚未实测** | `sbx secret --help`、`sbx secret ls`（只看名称）                                                |
| Claude Code 认证  | R8 中在 guest 终端执行 `claude-agent-acp --cli auth login --claudeai`，登录存于 guest `~/.claude`（未设 `CLAUDE_CONFIG_DIR`）；sbx 也支持 `anthropic` service secret，本轮未使用                                                           | [W3b 执行记录](../harness-acp-wiring-20261022/README.md) R8                                     |
| 无模型自检命令    | `codex login status`、`claude-agent-acp --cli auth status` 存在；输出内容、是否联网、是否含账号信息**尚未实测**                                                                                                                            | 两者的 `--help`                                                                                 |

交接与计划的差异：计划 W4 行只列 Profile 管理、无模型自检、每 Profile 并发上限、配额/认证失败报错和设置页列表；交接另把“界面 Harness/Profile 选择器（替代 `WSL_HARNESS`）”和“逐项审批界面（替代 `workspaceWritePolicy` 的自动放行）”归入 W4。见决定 W4-1。

## 2. 拟定范围（以 §6 的决定为准）

1. **Profile 记录**：`profileId`、`harnessId`、`environmentId`、`configDir`（运行环境内路径，或“默认”）、`label`，以及最近一次自检结果（时间、CLI 版本、是否已登录、失败原因）。不存任何凭据、令牌、账号邮箱或自检原始输出。
2. **无模型自检**：在所属运行环境内，以该 Profile 的配置目录运行 CLI 版本与登录状态命令，只解析出“已登录/未登录/无法判断”。不调用模型；无法判断时显示 `undetermined`，不当作已登录。
3. **按执行选择 Harness 与 Profile**：只列出自检通过的组合；`startRun` 把 Harness 与 `profileId` 一起冻结进 `HarnessRef`，之后不随界面变化。service 按每次执行的选择启动对应适配器，不再是进程级单值。
4. **配置目录传入 guest**：start 帧新增经校验的 Profile 字段，helper 只把它映射到该 Harness 声明的环境变量（如 `CLAUDE_CONFIG_DIR`），路径限定在约定目录内并做规范化；不接受任意环境变量。
5. **失败不换号**：认证失败或配额耗尽时执行失败并说明原因，不自动换到同一服务商的另一个 Profile。
6. **每 Profile 并发上限**：默认 1，在 `startRun` 检查；与 W0 写入许可同时生效。
7. **逐项审批**：ACP `session/request_permission` 经 service → Main → 界面，由用户逐项决定；等待期间执行显示“等待审批”，取消执行时待决请求回复 `cancelled`。Codex native 路径不变。
8. **设置页**：Harness 列表与自检结果；Profile 新建、自检、删除；登录引导打开对应运行环境的终端并显示登录命令。
9. **移除 `WSL_HARNESS`**（按决定 W4-9）。

## 3. 不在本包

- Lane（W5）与多个写入执行并行；在此之前全局写入并发仍为 1。
- Bot、会议、跨服务商备用 Harness（设计 §5 第 4 条依赖 Bot 定义）。
- 同一服务商账号自动轮换；Lab 读取、复制或转发凭据。
- 打包安装器的 guest 载荷（仍只有 Codex，交接 §8 已知缺口）；`SbxConnection` 的 Codex 版本探测。
- 本机与 SSH 运行环境的 Profile。
- R8 发现但与 Profile 无关的问题：App 页面浏览器分区为内存会话、`app_ui_act` 点击 `No node found at given location`、任务未绑定 App 时源码差异不可用。另行处理。

## 4. 验收（草案，决定后定稿）

| #   | 场景                               | 期望                                                                                                                                                                                                                                                |
| --- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | 同一 Harness 两个 Profile 分别自检 | 各自结果独立；一个未登录不影响另一个                                                                                                                                                                                                                |
| P2  | 自检                               | 不调用模型；结果只含是否登录与版本；无法判断时为 `undetermined`                                                                                                                                                                                     |
| P3  | 凭据扫描                           | 日志、协议 DTO、持久化文件、会话警告中不出现令牌与账号邮箱（测试扫描固定特征）                                                                                                                                                                      |
| P4  | 选择与冻结                         | `startRun` 把所选 Harness 与 `profileId` 冻结进执行记录，之后切换选择不影响已创建的执行；所选 Profile 已删除或不属于该 Harness 时以 `conflict` 拒绝、不留记录；Harness 不可用或 Profile 未登录时执行照常创建并以明确原因失败（见 §7 第 7 条的修正） |
| P5  | 认证失败/配额耗尽                  | 执行失败并说明原因；不自动换 Profile；没有新 TaskRun 被悄悄创建                                                                                                                                                                                     |
| P6  | 并发上限                           | 同一 Profile 第二个执行以 `conflict` 拒绝，不留下失败记录                                                                                                                                                                                           |
| P7  | 配置目录边界                       | 越界、相对路径、符号链接指向外部、未声明的环境变量名均被拒绝，不启动子进程                                                                                                                                                                          |
| P8  | 逐项审批                           | 允许、拒绝、超时、执行取消四条路径各有确定结果并记入会话；伪造来源或过期请求不能产生决定                                                                                                                                                            |
| P9  | 旧记录                             | 没有 `profileId` 的执行记录按旧出处显示，不改写持久数据                                                                                                                                                                                             |
| P10 | 回归                               | 既有单元测试与 Electron E2E 通过；Codex 缺省路径行为不变                                                                                                                                                                                            |
| P11 | 真实运行（需授权）                 | 两个 Claude Code Profile（或按 W4-2 决定的组合）各跑一次无模型自检与一次真实轮次，执行记录中的 `profileId` 正确                                                                                                                                     |

## 5. 实施顺序（建议）

协议与持久化 → service 按执行选择适配器与 Profile 字段 → helper 配置目录映射 → 自检 → Main `startRun` 冻结与并发检查 → 设置页 → 审批通道与界面 → E2E → 真实运行。每步单独可测；按决定 W4-1 拆分 PR。

## 6. 决定

2026-10-22 用户原话：“Accept the recommendations for W4-1 through W4-12. Record the decisions in the SPEC, then start W4a.” 下表各项均按“建议”一列执行；选项列保留作为取舍记录。由此确定：

- **W4a**（`agent/harness-profiles`）：Profile 记录与独立存储文件、无模型自检、按执行选择 Harness 与 Profile 并在 `startRun` 冻结、每 Profile 并发 1、配置目录经 helper 映射、设置页与会话选择、移除 `WSL_HARNESS`。Codex 在 sbx 中只有隐式的“sbx 默认”Profile；`CODEX_HOME` 能否另选账号的实测需要用户在场登录，结论写入执行记录后再决定是否扩展。
- **W4b**（叠在 W4a 上）：逐项审批通道与界面。默认策略按 W4-8 A，超时按 W4-10 A，不提供“始终允许”。

| #     | 问题                                                                                       | 选项                                                                                                                                                                                                                                                         | 建议                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| W4-1  | 交接把选择器与逐项审批界面也归入 W4，计划没有                                              | A. 全部放一个 PR；B. 拆为 W4a（Profile、自检、选择器、移除 `WSL_HARNESS`）与 W4b（逐项审批通道与界面），W4b 叠在 W4a 上                                                                                                                                      | **B**：审批涉及 service↔Main↔界面的新请求通道与超时、取消语义，单独审阅更清楚                                                              |
| W4-2  | sbx 中 Codex 的 Profile 怎样定义（账号可能由 sbx 代理按 secret 注入，而不是 `CODEX_HOME`） | A. 先实测 `CODEX_HOME` + guest 内 `codex login` 是否被代理覆盖，再定；B. Codex 每个 sandbox 只有一个隐式“sbx 默认”Profile，账号由用户在 host 上用 `sbx secret` 管理，Lab 只显示；C. Codex 的 Profile 对应按 sandbox 作用域的 secret（一个 sandbox 一个账号） | **B 先落地，同时做 A 的实测**：不阻塞 Claude Code 的多 Profile；A 的结论写入执行记录后再决定是否扩展                                       |
| W4-3  | Claude Code 现有登录（guest `~/.claude`，未设 `CLAUDE_CONFIG_DIR`）                        | A. 作为“默认”Profile（不设环境变量）保留；B. 一律要求显式配置目录，现有登录需重新登录到新目录                                                                                                                                                                | **A**：R8 的登录可直接沿用；新增 Profile 才使用显式目录                                                                                    |
| W4-4  | 新 Profile 配置目录放在哪                                                                  | A. 固定根 `/home/agent/.wsl-profiles/<harnessId>/<profileId>`，Lab 生成，用户不可填路径；B. 用户自填 guest 内任意绝对路径                                                                                                                                    | **A**：路径可校验，避免指向工作区或其他配置                                                                                                |
| W4-5  | Profile 记录存在哪里                                                                       | A. `workbench.json` 快照（schema 4 → 5，与 `environments` 并列）；B. userData 下独立的 `harness-profiles.json`，由 Main 单点写入并带 schema 版本；C. 安装配置 `runtime.json`                                                                                 | **B**：Profile 按运行环境而非空间组织；独立文件不迫使工作台迁移，凭据扫描范围也更清楚                                                      |
| W4-6  | 每 Profile 并发上限默认值与可调性                                                          | A. 默认 1，W4 不提供调整；B. 默认 1，设置页可调                                                                                                                                                                                                              | **A**：W0 许可已把全局写入并发限制为 1，可调没有实际效果，随 W5 再开放                                                                     |
| W4-7  | 选择的粒度                                                                                 | A. 设置页全局默认 + 会话内可改，`startRun` 冻结；B. 每次确认任务时必选；C. 只有全局                                                                                                                                                                          | **A**                                                                                                                                      |
| W4-8  | 逐项审批的默认策略                                                                         | A. 维持现有自动放行的类型（sbx 为隔离边界），只把原先直接拒绝的 `fetch`、`switch_mode`、未知类型改为询问用户；B. 读、搜索、思考自动放行，写、删、移动、执行及 MCP 都询问；C. 全部询问                                                                        | **A**：B/C 会让每条 shell 命令都弹审批，且 Codex 路径没有对等审批，两种 Harness 的体验差距过大。如选 B，需另定“允许本轮同类”之类的批量选项 |
| W4-9  | `WSL_HARNESS` 的去留                                                                       | A. 移除；B. 保留为开发期覆盖默认值                                                                                                                                                                                                                           | **A**：开发规范要求替换接口时不保留已淘汰接口；E2E 改用正式选择入口                                                                        |
| W4-10 | 审批无人响应时                                                                             | A. 等待 10 分钟后按拒绝处理并记警告；B. 一直等待直到用户处理或取消执行；C. 其他时长                                                                                                                                                                          | **A**：避免执行无限期占用写入许可                                                                                                          |
| W4-11 | 是否提供“始终允许”（ACP `allow_always`）                                                   | A. 不提供，只有一次性允许与拒绝；B. 提供，范围限于当前会话                                                                                                                                                                                                   | **A**：与设计 D8“不提供始终允许”的取向一致；需要时另立合同                                                                                 |
| W4-12 | 登录引导                                                                                   | A. 打开对应运行环境的终端，显示登录命令供用户自己输入；B. 打开终端并代为输入命令（不按回车）；C. 只显示命令                                                                                                                                                  | **A**：登录由用户本人完成，Lab 不代为执行认证命令                                                                                          |

未在此列出的细节（字段名、错误码文案、界面布局）实施时按现有约定处理，并在执行记录中说明。

## 7. W4a 实施设计

2026-10-22 实测（guest `wsl-sbx-smoke-20261006`，输出中的邮箱与组织标识已遮蔽，未保存原文）：

| 命令                                 | 已登录                                        | 未登录（空目录）          | 备注                                                                                                   |
| ------------------------------------ | --------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `claude-agent-acp --cli auth status` | 退出 0，JSON `loggedIn: true`                 | 退出 1，`loggedIn: false` | JSON 同时含 `email`、`orgId`、`orgName`；`CLAUDE_CONFIG_DIR` 生效；该命令会在目录内写入 `.claude.json` |
| `codex login status`                 | 退出 0，“Logged in using an API key - \*\*\*” | 退出 1，“Not logged in”   | `CODEX_HOME` 生效；sbx 中的 API key 推测为代理注入的占位，未验证                                       |

据此：

1. **协议**（`packages/protocol`）：新增 `HarnessProfile`（`profileId`、`harnessId`、`environmentId`、`configDir`（`null` 为默认）、`label`、`builtin`、`createdAt`、`check`）、`ProfileCheck`（`checkedAt`、`cliVersion`、`login: logged_in | logged_out | undetermined`、`reason`）与 `HarnessSelection`（`harnessId`、`profileId`）。`HarnessRef` 增加可选 `profileId`，旧记录缺省即为旧出处。`ChatStatus` 的单值 `harness` 改为 `harnesses`：每个已注册 Harness 的描述符与可用性。
2. **内置 Profile**：`codex:default`（W4-2 B，“sbx 默认”）与 `claude-code:default`（W4-3 A，guest `~/.claude`），`configDir: null`、`builtin: true`，不可删除。新建 Profile 只允许 `claude-code`，目录由 Lab 生成为 `/home/agent/.wsl-profiles/<harnessId>/<profileId>`（W4-4 A）。
3. **存储**（W4-5 B）：userData 下 `harness-profiles.json`，`schemaVersion: 1`，含 Profile 列表与默认选择；Main 单点写入，原子替换；未知较新版本报错且保留原文件。自检只保存解析后的字段。
4. **自检**：service 新方法在 guest 内以一次性进程运行版本命令与登录状态命令，配置目录经 start 帧传入；Claude Code 只从 JSON 取 `loggedIn`，Codex 只按退出码与固定前缀判断，其余输出丢弃，解析失败为 `undetermined`。
5. **start 帧**：新增 `profileDir: { env, path }`。service 与 helper 各自校验：`env` 只能是该 Harness 声明的变量（`CLAUDE_CONFIG_DIR`、`CODEX_HOME`），`path` 必须匹配上述根目录格式；helper 在 guest 内逐级拒绝符号链接，以 `0700` 创建目录后只设置这一个环境变量。
6. **执行核心**：`CodexChat` 持有全部已注册 Harness，启动时分别探测；`send` 接收本轮的选择。会话槽记录 `threadId` 所属的 `(harnessId, profileId)`，选择变化时不复用旧 `threadId`，开始新的 Agent 会话并记一条警告。
7. **Main**：会话增加可选的 Harness 选择（W4-7 A，空为跟随全局默认）。`startRun` 解析选择 → 所选 Profile 已删除或不属于该 Harness 时以 `conflict` 拒绝 → 同一 Profile 已有活动执行时以 `conflict` 拒绝（W4-6 A）→ 把含 `profileId` 的 `HarnessRef` 冻结进执行记录。启动路径上（不占用 Main 元数据队列）再判断 Harness 是否可用；Profile 未自检或上次不是已登录时先重新自检，仍不是已登录则执行以明确原因失败，不换用其他 Profile。个人对话使用全局默认。
   - 2026-10-22 修正：初稿让 `startRun` 在 Harness 不可用或 Profile 已知未登录时直接拒绝、不创建执行。全量 E2E 显示这违反了既有约定“执行器不可用时保留草稿并记录失败运行”（`e2e/sbx.spec.ts`、`e2e/status-surface.spec.ts` 中 4 项失败），因此改为上述做法；P5 的“执行失败并说明原因”与之一致。执行服务尚未报告任何 Harness 时，冻结的出处使用内置 Harness 的固定名称与接入方式，版本记为 `null`，发送沿用执行服务给出的原始原因失败。
8. **界面**：`window.studio` 顶层仍为 6 个键（status-interface §8.1）；Profile 管理放在 `chat.profiles`。设置页列出 Harness 与 Profile，可新建、自检、删除、设为默认，并显示登录命令（W4-12 A）；会话中显示并可改本会话的选择。
9. **移除 `WSL_HARNESS`**（W4-9 A）：service 不再读该变量；`current-runtime.md` 同步更新。

## 8. W4b 实施设计

分支 `agent/harness-approvals`，叠在 W4a（`agent/harness-profiles`，PR #25）上。按 W4-8 A、W4-10 A、W4-11 A：

1. **策略**：ACP 权限请求中，工作区内的读、写、删、移动、搜索、执行、思考、其他照旧自动放行一次；原先直接拒绝的 `fetch`、`switch_mode` 与未知类型改为交给用户。只提供一次性选项：请求里的 `allow_always`、`reject_always` 不展示也不接受。允许类型但没有一次性允许选项的请求照旧拒绝并记警告。Codex native 路径不变。
2. **请求信息**：ACP 的权限请求可能只带 `toolCallId`；执行核心用本轮已知的工具状态补齐标题与类型，再交给策略与界面。请求内容来自 Agent，按不可信数据展示，长度有界。
3. **待决请求是执行事实**：由 service 写入会话快照的 `permissionRequests`（请求身份、所属轮次、工具标题与类型、一次性选项、截止时间），经现有快照流到 Main、执行记录与界面。每轮最多 4 个待决请求，超出的直接拒绝并记警告。
4. **回复**：界面经 Main 回复。空间会话走工作台命令 `answerPermission`，个人对话走 `chat:permission-reply`；Main 只核对会话归属与请求是否仍待决，再转给 service。service 再次核对请求身份、所属轮次与选项后才答复 Agent；已结束、已超时或重复的回复被拒绝，不产生决定。
5. **超时与结束**：10 分钟无人回复按拒绝处理并记警告（W4-10 A）；轮次取消、失败或结束时，待决请求一律答复 `cancelled` 并从快照移除。每个决定（用户允许、用户拒绝、超时拒绝）记一条会话警告作为出处。
6. **界面**：会话与个人对话中，待决请求显示为一张卡片：工具标题与类型、截止时间、“允许一次”与“拒绝”。只有对应轮次仍在运行时显示。

验收：P8（允许、拒绝、超时、执行取消四条路径各有确定结果并记入会话；伪造或过期请求不能产生决定），以及 P10 回归。E2E 中由 fixture sbx 把 `claude-agent-acp` 映射到确定性的假 ACP Agent，只在测试环境变量存在时生效，不改产品代码。
