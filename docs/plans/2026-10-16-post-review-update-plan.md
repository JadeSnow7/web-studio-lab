# 评审后代码更新计划 · 2026-10-16

2026-10-25 整合注记：本文保留 2026-10-16 的评审基线、赛程设想及经 PR19 去重后的计划。旧 PR/日期/待办状态均为历史，不作为本次恢复旧 PR10、执行 10 月 28 日冻结或启动部署/移动端的指令。当前未完成项须核对当前源码和实际回执；运行环境需另立 ADR/SPEC，部署仍需明确授权。本文引用的多 Harness W 编号统属 MHC，与 Workflow 的 WF 编号分开。

本计划承接 2026-10-16 参赛候选 [PR #10](https://github.com/JadeSnow7/web-studio-lab/pull/10)（候选提交 `d91701382e5e8950d695e9ef21fa521043407660`，基线 `b5531e1`）的评审与本地回归结论，分为两部分：**A. 评审问题修复**，把候选整理成可合并、可持续回归的主线；**B. 补充机制**，把产品从“Codex + sbx 单通路”扩展为“AI 浏览器 + 全栈开发工作台，多 Harness、多运行环境”。

依据：

- 候选整合验收 [`docs/acceptance/submission-20261016/README.md`](https://github.com/JadeSnow7/web-studio-lab/blob/agent/submission-20261016/docs/acceptance/submission-20261016/README.md)（位于 `agent/submission-20261016` 分支） 中的本地回归表和遗留项。
- 今日只读审核反馈，共 6 类，见下文 A1–A6。
- 赛程：10 月 21 日公布入围名单，10 月 29 日现场决赛（10 分钟讲解 + 5 分钟问答），入围后可继续迭代，路演采用迭代后版本。

开发流程沿用 [AGENTS.md](../../AGENTS.md) 和 [CONTRIBUTING.md](../../CONTRIBUTING.md)：明确验收 → 最小实现 → 针对性验证 → 审阅交付。每个工作包一个小 PR，分支名用 `agent/<topic>`。执行结束、验证通过、用户接受分别记录。不通过删除断言、调高超时或改冻结基线来制造“通过”。

---

## 0. 总体节奏

| 阶段        | 时间        | 目标                                                                                                                                                                          | 出口条件                                                      |
| ----------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| P0 冻结提交 | 10/16 当晚  | 参赛材料按 `d917013` 提交，不再改动 PR #10 代码                                                                                                                               | 提交邮件发出；视频链接可访问                                  |
| P1 主线归位 | 10/17–10/18 | 合并 PR #10；CI 增加 Linux 与 Electron E2E；`pnpm check` 在不改冻结字节的前提下可全绿                                                                                         | main 上 validate CI、Linux CI、默认 E2E 全部通过              |
| P2 评审修复 | 10/19–10/23 | 修完 A2–A5 的安全边界、身份生命周期和导出合同问题                                                                                                                             | 每项有回归测试；魔塔 / 手帐两条场景在新构建上重跑             |
| P3 补充机制 | 10/22–10/27 | Harness 端口与 Claude Code 接入（见[多 Harness 协作计划](2026-10-21-multi-harness-collaboration.md) W0–W3）；运行环境端口（sbx / 本机 / SSH）；浏览 / 开发 / 设计三种布局预设 | 手帐场景在两种 Harness 下各跑通一次；SSH 环境跑通一次受管 App |
| P4 决赛冻结 | 10/28       | 冻结决赛构建，彩排演示                                                                                                                                                        | 决赛构建的提交号、构建号、演示回执一一绑定                    |
| P5 赛后     | 11 月起     | 容器环境、远程部署、Expo 移动端、Windows / Linux 安装包                                                                                                                       | 按各自 SPEC 验收                                              |

P2 和 P3 可以并行，但同一文件同一时间只能有一个写入者。`apps/service/src/codex-chat.ts`、`apps/desktop/src/main/chat-service.ts` 同时被 A2 和[多 Harness 协作计划](2026-10-21-multi-harness-collaboration.md) W2 涉及，**A2 先合并，W2 再基于它重构**。

### P0 · 今晚只做的事

- 不向 `agent/submission-20261016` 推送代码。参赛文档引用的是固定提交号，之后合并或继续开发都不会影响评审定位。
- 上传两段视频，把链接填进参赛文档；按 FAQ 把仓库链接、视频链接和 PDF 发到 oscc@oschina.cn。
- 合并 PR #10 放在 10/17 进行（见 P1）。

---

## A. 评审问题修复

### A1 · Linux 清理测试签名与 Linux CI 覆盖（P1，高优先级）

**问题**

- `apps/service/src/guest-workspace.test.ts:59` 注入的替代函数是 `def cleanup(sid, child)`，只有两个参数。
- 生产代码 `apps/service/src/guest-helper.py:247` 的签名是 `cleanup(sid, child, leader_identity=None)`，第 630、633、637、652 行都用三个参数调用。
- 这组测试用 `describe.skipIf(process.platform !== 'linux')` 包住，macOS CI 从未执行，所以签名不一致一直没被发现。

**修改**

1. 替代函数改为 `def cleanup(sid, child, leader_identity=None): confirmed_cleanup(sid, child, leader_identity); raise RuntimeError(...)`，签名与生产保持一致。
2. 测试启动时检查注入后的签名：用 `inspect.signature` 比对生产函数，不一致就直接失败，防止以后再漂移。
3. `.github/workflows` 新增 `linux-service` job：ubuntu-latest、Node 24、pnpm 10.34.6、Python 3.12，执行 `pnpm exec vitest run apps/service/src/guest-workspace.test.ts` 以及其他带 `skipIf(platform !== 'linux')` 的测试文件。
4. 如果 CI 主机的 `/proc` 被虚拟化，`faithfulProc` 为假时测试会打印 `NOT_RUN`。CI 要把 `NOT_RUN` 当作“未覆盖”上报，不能算通过；需要时改用自托管 runner 或在容器里加 `--pid=host` 再跑一遍。

**验收**：Linux job 中这组测试真实执行并通过；新增一个“签名漂移”反例测试，签名不一致时必须失败。

### A2 · 魔塔受限任务的命令执行边界前移（P2，安全，高优先级）

**问题**

- `apps/service/src/codex-chat.ts:472-487` 只在 `item.completed` 时统计和校验 `command_execution`，属于事后发现，命令已经执行完了。
- 每轮新建的只读 scratch 里没有工程源码，但同一个 guest 里的模型仍可能读到受管 App 的源码目录。
- 全运行期写入租约返回 423，确实限制了写入，但不构成完整隔离。
- 只读 Codex 的 OS 探针缺少 `--permission-profile` 参数，在执行探针代码前就退出了，隔离效果至今没有有效证据。

**修改**

1. **事件层**：魔塔任务轮次的协议里，`command_execution` 被列为不允许的工具。收到 `item.started` 时立即取消本轮，记录 `policy_violation`，走既有的取消与清理确认流程；`item.completed` 仍然保留校验，作为第二道防线。
2. **启动层**：魔塔轮次启动 Codex 时显式指定只读权限配置（补上 `--permission-profile`，并在 argv 测试中固定）。如果 Codex 版本支持，就关闭 shell 工具，只保留 4 个 `app_mota_*` MCP 工具。
3. **文件层**：受管 App 的源码目录归属单独的 guest 用户，权限设为 0700；Codex 用另一个 guest 用户运行，scratch 只对它可写。
4. **证据**：补跑 OS 隔离探针，在源码目录放一个 canary 文件，验证模型进程既读不到也写不到，并保留探针回执。

**涉及文件**：`codex-chat.ts`、`guest-helper.py`、`mota-app-service`、`e2e/mota-agent-live.spec.ts`、`docs/acceptance/mota-ai-*/`

**验收**

- 单元测试：模拟 `item.started` 的 command_execution 事件，本轮被取消，后续工具调用都不会派发。
- live 测试：tools 和 model 两种模式在新构建上各重跑一次，路线 MT4(11,10)、HP 926、金币 7/14 保持一致。
- OS 探针回执有效。

### A3 · 编辑器会话的页面信任边界（P2，安全）

**问题**

- `apps/service/src/mota-server.cjs:597-885` 把编辑器会话 nonce 写在页面 `<script data-wsl-editor-session>` 里，请求时再通过请求头带回。
- 同源但不可信的 JavaScript（比如被导入工程里的游戏脚本）可以读取这个 nonce，冒充编辑器去请求保存接口。

**修改**

1. 游戏页和编辑器页拆到**不同 origin**（受管服务分别监听两个端口），浏览器的同源策略天然把两边隔开。
2. nonce 不再写进 DOM：由 Main 在编辑器 webContents 上通过 CDP `Network.setExtraHTTPHeaders` 注入，只对该 webContents 生效，页面脚本读不到。
3. 编辑器保存接口额外校验 `Origin`，并加 CSP，禁止内联脚本和第三方连接。
4. 在 `docs/architecture/current-runtime.md` 里写明可信页面清单和工具授权边界：页面内容永远只是数据，授权只来自 Main。

**验收**：增加一个“恶意游戏脚本”fixture，它尝试读取 nonce 并调用保存接口，必须失败；编辑器正常保存和互斥逻辑仍然通过。

### A4 · 身份一致性与长期运行回收（P2）

**问题**

- `packages/protocol/src/status.ts:112` 中 `projectId: z.string()`，而 `managed-app.ts`、`app-import.ts`、`edu-task.ts`、`workspace.ts` 都用 `z.uuid()`，同一字段格式不一致。
- `workspaceId` 的冲突检查只在 `createWorkspace` 里做（`application.ts:2977`），迁移、导入和恢复路径没有统一的唯一性约束。
- `apps/desktop/src/main/workbench/application.ts:1096` 的 `appCommands` 去重表没有回收机制：普通 `commands` 有 2048 条上限，导入类命令的幂等记录会一直增长。

**修改**

1. 在 `packages/protocol` 定义统一的 `ProjectIdSchema` 和 `WorkspaceIdSchema`，全仓替换；读取旧快照时做一次规范化迁移，不合法的身份要明确报错，不能静默丢弃。
2. 唯一性约束下沉到 repository 层：加载、迁移、导入、恢复四条路径都经过同一个 `assertUniqueWorkspaceId`。
3. `appCommands` 改为两部分：在途命令永不回收；已结束的命令按“上限 2048 条 + 最近使用顺序”回收。被回收的命令如果重试，按“查询事实”处理，不重放副作用，与 `commands` 的现有约定保持一致。
4. 增加长期运行回归：连续提交 5000 条导入、App 命令，检查内存中的记录数有上限，重复 commandId 的语义保持正确。

**验收**：协议测试覆盖旧格式迁移；application 单测覆盖回收和重放边界；`migration-regressions.test.ts` 新增 workspaceId 冲突用例。

### A5 · 导出预算统一（P2）

**问题**

- 标准导出在 service 侧上限是 512 KiB（`apps/service/src/app-service.ts:146`、`guest-helper.py:28`）。这是基线已有的限制，不是本次引入的回归。
- guest 侧 `apps/service/src/app-helper.py:26` 是 `LIMIT = 8 * 1024 * 1024`。两端口径不一致，8 MiB 也不是端到端的承诺。
- 跨平台导出还没有验收。

**修改**

1. 在 `packages/protocol/src/managed-app.ts` 定义唯一的 `APP_EXPORT_BUDGET`，按标准模板、edu、mota 三种 profile 分别给出文件数和字节数上限。
2. guest helper 不再写死上限，改为由 service 通过启动参数传入；helper 启动时回显实际生效的预算，service 核对一致后才继续。
3. 三端（protocol / service / helper）共用一组边界测试：limit−1 通过、limit 通过、limit+1 整体拒绝，并给出明确原因。
4. 在 macOS 和 Linux 上各跑一次导出验收，Windows 放到 P5。

**验收**：边界测试三端一致；`source-export.test.ts`、`app-service.test.ts` 更新；`current-runtime.md` 记录最终预算。

### A6 · 检查链与异步保存异常（P1）

**问题**

- `pnpm check` 在冻结的 VS001 文件 `tests/vertical-slice/cdp.ts:16`（prefer-const）处停下，后面的格式检查和测试都没有执行。
- `format:check` 有 8 个文件失败：7 个冻结的 VS001 文件，另一个是历史收尾文档 `closeout-20261014.md`。
- `apps/service/src/app-service.ts` 第 572、962、1064、1227 行的 `void child.done.then(...)` 没有处理 rejection，保存失败时可能变成未处理异常，状态也不会更新。

**修改**

1. **冻结基线**：把 VS001 冻结文件加入 ESLint 和 Prettier 的忽略列表，同时新增 `scripts/check-frozen.mjs`，按 SHA-256 清单核对这些文件的字节没有变化，并把它接进 `pnpm check`。这样冻结文件不会被改动，检查链也能跑完。
2. **历史档案**：`closeout-20261014.md` 移到 `docs/acceptance/**/archive/` 下并加入忽略列表，保留原字节。
3. **异步保存**：4 处 `child.done.then` 都补上 rejection 处理：记录日志，把对应状态置为 `unavailable`，并附上原因。启用 `@typescript-eslint/no-floating-promises`，`void` 只允许用于已经处理过异常的 Promise。
4. **测试**：模拟 `child.done` 被 reject，断言进程不崩溃，状态为可见的失败。

**验收**：在 main 上执行 `pnpm check`，退出码为 0；冻结清单核对通过。

### A7 · 测试稳定性与已知产品缺陷（P1–P2，穿插进行）

| 项                   | 现状                                                                                                                  | 处理                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| E2E 模板依赖         | 根目录的 `pnpm install` 不会安装 `templates/standard-app` 的独立依赖（如 `tsx`），导致 `app-control-harness` 首轮失败 | Playwright globalSetup 检查模板依赖，缺失时执行 `npm ci --ignore-scripts`；CI 增加缓存      |
| Electron E2E 不在 CI | 只在本地跑，首轮失败和复跑结果分开记录                                                                                | 新增 macOS `e2e-default` job，跑完整默认套件（live 用例按设计跳过），失败上传 error-context |
| 并发下的超时         | MCP wrapper 用时 6.3 秒超过 5 秒默认超时；observation 64 次预算用例在并行时超时                                       | 先在 CI 单独跑定位根因，不调高超时；确实是资源争用的，测试改为串行项目                      |
| “比赛环境未就绪”提示 | 误报未修复                                                                                                            | 定位提示的触发条件，补一条状态投影测试                                                      |
| Wikivoyage 回执缺陷  | 研究回执字段不完整                                                                                                    | 修复研究回执的投影，补一条 fixture 测试                                                     |
| UI 聚合记录上限      | 达到上限后历史被截断                                                                                                  | 历史改为分页读取，超出部分标注“已归档”，不静默丢弃                                          |
| 模板依赖审计         | esbuild 有 1 个 low 级提示（Windows 开发服务器场景）                                                                  | 在模板锁文件内升级到修复版本，单独提 PR 并重跑模板测试                                      |
| 本机 Node 版本       | 本地是 Node 26，项目目标是 Node 24                                                                                    | 用 `.nvmrc` 和 `engines` 强制约束；本地验收统一切到 Node 24                                 |

---

## B. 补充机制

产品定位：**Web Studio Lab 既是一个 AI 浏览器，也是一个全栈开发工作台**，服务普通用户和专业用户（开发者、设计者）。底层不绑定 Codex + sbx，而是支持多种 Harness / Agent，以及多种沙箱、运行和远程部署机制。

多 Harness、多账号（Profile）、并行、Bot 与会议、跨 Agent 上下文统一由[多 Harness 协作设计](../design/2026-10-21-multi-harness-collaboration.md)、[ADR-0003](../architecture/adr/0003-pluggable-harness-and-collaboration.md) 和[实施计划](2026-10-21-multi-harness-collaboration.md)负责，范围条款（AGENTS.md、ARCHITECTURE.md）的修改见该计划 W1。本计划原 B1 已并入其中并删除，下文只保留运行环境、部署、普通用户模式、设计者工作流与平台。运行环境端口（B2）的取舍在开工时另立 ADR-0004。

### B2 · 运行环境端口：sbx / 本机 / SSH，后续容器（P3–P5）

**现状**

- 协议里已有 `Environment = z.enum(['local', 'sandbox', 'ssh'])`（`packages/protocol/src/resource-catalog.ts:9`）和 `environmentsList()`。
- 本机 PTY（`local-terminal.ts`）、SSH 终端和 SFTP 观察（`ssh-terminal.ts`、`observation-ssh.ts`）已经接入。
- 但 Agent 执行和受管 App 只走 `SbxConnection` / `GuestProcess`（`apps/service/src/sbx.ts`）。

**设计**

1. 定义 `ExecutionEnvironment` 端口，提供以下能力：
   - 执行进程（exec / pty）；
   - 有界的文件读写；
   - 端口暴露（本地映射或 SSH 转发）；
   - 生命周期：准备、健康检查、清理确认；
   - **隔离等级声明**：`none` / `os-sandbox` / `vm` / `remote`。
2. **sbx 适配器**：把 `SbxConnection` / `GuestProcess` 收进端口，行为不变。
3. **本机适配器**：隔离等级为 `none`。在本机执行 Agent 必须由用户在界面上明确授权，任务界面常驻显示风险标识；默认不开启。
4. **SSH 适配器**：复用现有的 SSH agent 认证、host-key 固定和 SFTP 范围限制，新增远程 exec（用于 Agent 和受管 App 启动）以及 App 端口转发，让 Browser 能打开远程主机上的受管 App。
5. **容器适配器（P5）**：支持 Docker / OrbStack / Podman，镜像固定摘要，工作目录用卷挂载，网络策略默认拒绝，按需放行。
6. TaskRun、AppInstance、VerificationResult 都记录 `environmentId` 和隔离等级；同一场景在不同环境下的验证结果互不替代。

**验收**

- 受管 App 在 SSH 远程主机上完成一次“创建 → 启动 → Browser 打开 → 停止”，所属进程和端口转发确认清理。
- 本机环境未经授权时拒绝执行 Agent，有测试覆盖。
- sbx 回归全部通过。

### B3 · 远程部署（P5）

- 第一步只做“部署到用户自己的 SSH 主机”：受管 App 构建产物 + 运行配置 → 远程启动 → 健康检查 → 回执。
- 这一步会改变首版“不做生成 App 部署”的范围约定，开工前需要单独的 SPEC 和用户授权，并在 ADR-0004 中补充说明。
- 云端运行环境（托管开发机）放到更后面，接口沿用 B2 的端口。

### B4 · AI 浏览器的普通用户模式（P3）

**目标**：不写代码的用户打开就能用。

1. **布局预设**：提供“浏览 / 开发 / 设计”三种空间布局，作为展示偏好按设备保存，不改变业务状态。“浏览”预设默认隐藏终端、任务、diff 等开发面板。
2. **页面问答**：在 Browser 工具栏一键把当前页面现场作为本轮上下文交给 AI（复用现有的页面采集和资源快照通路），支持摘要、摘录和整理到收藏。
3. **一句话小工具**：从浏览模式直接创建标准 App，走现有的模板生成与验证闭环，界面只展示“可用 / 验证结果”，开发细节折叠起来。
4. **研究保存**：沿用手帐场景的检索 → 读取 → 显式纳入 → 保存流程，作为普通用户的“资料整理”能力对外提供。

**验收**：Playwright 覆盖三种预设的切换和恢复；一条“浏览网页 → 页面问答 → 生成小工具 → 刷新核对数据”的 E2E 用例（默认用 fixture 模型，live 用例需授权单独跑）。

### B5 · 设计者工作流（P3–P5）

1. **元素点选成任务**：在运行中的页面上点选元素，冻结 DOM 片段、截图和样式作为任务上下文（复用页面采集和文档身份绑定），AI 修改后在同一元素位置做前后截图对比。
2. **设计令牌面板（P5）**：读取模板的主题令牌（颜色、字号、间距），修改后由 AI 同步到代码，与 `DESIGN.md` 和 `UX-CONTRACT.md` 的约定对齐。
3. **视觉验收**：把截图对比作为一类 VerificationResult，与功能验证分开记录。

**验收**：一条“点选按钮 → 改颜色和圆角 → 前后截图对比 → 用户接受”的端到端用例。

### B6 · 模板与平台（P5）

- Expo / React Native：按已完成的[第一阶段设计](../design/2026-10-11-expo-android-phase1.md)和[实施计划](2026-10-11-expo-android-phase1.md)推进。
- 打包：Windows 和 Linux 安装包，以及 macOS 签名和公证。签名凭据由用户本人操作，不进入仓库。

---

## C. PR 拆分与依赖

| 顺序 | 分支                                                               | 内容                                                                                     | 依赖                |
| ---- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------- |
| 1    | —                                                                  | 合并 PR #10 到 main                                                                      | P0 完成             |
| 2    | `agent/ci-linux-e2e`                                               | A1 + A7 的 CI 部分（Linux job、E2E job、模板依赖 globalSetup）                           | 1                   |
| 3    | `agent/check-frozen-baseline`                                      | A6 冻结清单、忽略列表、floating promise 修复                                             | 1                   |
| 4    | `agent/mota-pre-exec-boundary`                                     | A2                                                                                       | 2                   |
| 5    | `agent/editor-origin-split`                                        | A3                                                                                       | 1                   |
| 6    | `agent/identity-lifecycle`                                         | A4                                                                                       | 3                   |
| 7    | `agent/export-budget-contract`                                     | A5                                                                                       | 3                   |
| 8–10 | 见[多 Harness 协作计划](2026-10-21-multi-harness-collaboration.md) | W0 项目写入许可、W1 范围文档、W2 Harness 端口与 Codex 迁移、W3 ACP 适配器（Claude Code） | W2 依赖 4           |
| 11   | `agent/env-port-ssh`                                               | B2 端口 + sbx 迁移 + SSH exec / 端口转发 + 本机授权（含 ADR-0004）                       | 协作计划 W1         |
| 12   | `agent/browse-mode-presets`                                        | B4                                                                                       | 1                   |
| 13   | `agent/design-element-task`                                        | B5 第 1、3 项                                                                            | 12                  |
| 14   | `agent/final-freeze-20261028`                                      | 决赛构建冻结与演示回执                                                                   | 2–13 中已合并的部分 |

每个 PR 的说明写清楚四件事：改动路径；实际执行的命令和结果；没跑什么、为什么没跑；还没实现的部分。

---

## D. 验证矩阵

| 层级           | 每个 PR                                     | 合并到 main       | 决赛冻结前                                                    |
| -------------- | ------------------------------------------- | ----------------- | ------------------------------------------------------------- |
| 静态           | typecheck、改动文件的 lint 和格式、冻结清单 | `pnpm check` 全绿 | 同左                                                          |
| 单元           | 相关 Vitest / Python 测试                   | `pnpm test` 全量  | 同左                                                          |
| Linux          | 涉及 service 的 PR 跑 Linux job             | Linux job 全绿    | 同左                                                          |
| Electron E2E   | 改动相关的 spec                             | 默认套件全量      | 默认套件 + packaged                                           |
| live（需授权） | —                                           | —                 | 魔塔 tools / model、手帐 × 2 种 Harness、SSH 受管 App，各一次 |
| 用户接受       | —                                           | —                 | 由作者在决赛构建上亲手确认，单独记录                          |

验收必须绑定构建：录像、live 回执和 CI 结果分别标注提交号和构建号，后来的构建不能沿用之前构建的模型验收结论。

---

## E. 风险与应对

| 风险                                                  | 影响                 | 应对                                                                                                                |
| ----------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Harness 重构波及魔塔 / 手帐两条已验证的通路           | 决赛演示回退         | 协作计划 W2 先做“行为不变的迁移”并单独合并；两条通路在新构建上重跑后再接 Claude Code                                |
| Claude Code 非交互模式的事件或权限语义与 Codex 不一致 | 只读策略或取消不可靠 | 契约测试先行；做不到的能力在 `describe()` 中如实声明，界面不提供对应选项                                            |
| Linux CI 的 `/proc` 被虚拟化                          | 清理测试实际未运行   | 输出 NOT_RUN 并上报；改用自托管 runner 或容器补跑                                                                   |
| 决赛前时间不足                                        | 补充机制做不完       | 优先级：A1–A6 > 协作计划 W0–W2（写入许可、Codex 迁移）> B4 > W3（Claude Code）> B2 SSH > B5；决赛只演示已验收的部分 |
| 第三方魔塔资产许可                                    | 演示素材不能公开     | 继续由用户自备工程；公开视频只使用许可明确的素材                                                                    |

---

## F. 需要同步更新的文档

- `docs/architecture/current-runtime.md`：Harness 和运行环境端口的实际接线；A2–A5 的新边界。
- `docs/architecture/adr/0004-pluggable-environment.md`：B2 开工时新增；Harness 部分见 ADR-0003。
- `AGENTS.md`、`docs/ARCHITECTURE.md`：范围表述由协作计划 W1 修改；本计划只补新的检查命令。
- `README.md`：能力表增加 Harness / 运行环境两行，以及浏览 / 开发 / 设计三种布局预设。
- 每个工作包对应一份 `docs/acceptance/<topic>-YYYYMMDD/README.md`。
