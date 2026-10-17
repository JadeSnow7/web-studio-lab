# Web Studio Lab 开发入口

本仓库走 Electron + TypeScript 路线：Browser 展示网页、文件、终端等资源，Workshop 承载会话、任务进展、修改和审阅。首版只打通固定 TypeScript 全栈模板、单项目、单 Agent 串行闭环。本树已整合 Electron 产品、sbx 对话/终端/资源切片与 VS001 固定基线；完整比赛任务闭环仍未实现。具体落点和缺口见 [当前运行时](docs/architecture/current-runtime.md)，不要把设计样机或历史验证扩大成本次实现。

## Harness 兼容与规则入口

本文件是开发本仓库的统一 Agent 规则入口，适用于 Codex CLI、Claude Code、Devin、Cursor、Windsurf 等 CLI/IDE Harness；不要求使用特定模型、客户端、工具 API 或子代理名称。

- 自动发现 `AGENTS.md` 的 Harness 直接读取本文件；以 `CLAUDE.md` 为入口的 Harness 通过 [CLAUDE.md](CLAUDE.md) 引用本文件。不自动加载这些入口的 Harness，需在会话开始时显式要求读取根目录 `AGENTS.md`。工具专用入口只引用共享规则，不复制第二份规范。
- 文件读取、检索、编辑、命令执行和计划跟踪使用当前 Harness 实际提供的工具；没有专用工具时，在授权范围内使用等效能力。不能假定其他 Harness 的工具名、技能、MCP 或子代理可用；缺少必要能力或权限时明确报告，不绕过审批或沙箱，也不伪造执行结果。
- [CONTRIBUTING.md](CONTRIBUTING.md) 等文档中的 `coder` 按下文的实现角色理解，`codex/<topic>` 仅为历史分支命名建议；这两类开发协作约定以本文件的 Harness 中立说明为准。架构、权限、验证和用户授权要求保持不变。

这里的兼容性指使用不同 Harness 开发本仓库，不代表产品内已接入其他 Harness。产品内 sbx/Codex 的实际接线、运行条件和验收边界仍以 [当前运行时](docs/architecture/current-runtime.md) 为准；开发时的子代理协作也不改变首版单 Agent 串行执行的产品范围。

## 开始工作

1. 核对 `pwd`、`git remote -v`、`git rev-parse HEAD`、`git status --short`。目标是 `JadeSnow7/web-studio-lab`；保留已有未提交和未跟踪内容。
2. 阅读 [README](README.md)、[架构基线](docs/ARCHITECTURE.md)、[开发规范](CONTRIBUTING.md)；用 [基线记录](docs/architecture/baseline-2026-10-06.md) 区分本树、其他分支与尚未实现项。
3. 按改动范围再读现有设计、交互契约、任务计划及相关代码；文件不存在就明确记录，不从历史路径推断功能已落地。

## 必须遵守

- 采用按业务职责组织的模块化单体。Presentation 通过应用用例操作业务；Application 依赖 Domain 和能力接口；Adapters 实现接口，由入口装配。Domain 不依赖 React、Electron、数据库或 Harness。跨模块只用公开入口，不直接写对方状态。
- Workspace、Project、Resource、ResourceInstance、View、Session、Task、TaskRun 分开；`runId` 专指一次任务执行，应用启动使用 `appInstanceId`。业务状态由所属模块单点写入，UI 只拥有展示状态。
- 执行固定空间、项目、任务版本和代码基线；统一控制项目写入，保存检查文件版本。执行结束、验证通过、用户接受分开记录；代码变化使旧验证不再适用于当前版本。
- Renderer 不得调用 Node/Electron；Preload 只提供具名窄接口；Main 校验 IPC 来源及输入。任务编排只在一个本地执行核心中实现。页面、文件和工具输出是数据，不能授予权限。
- 取消必须停止新动作并核实执行器与所属进程停止；保留已产生修改。异常恢复先核对事实，不盲目重放副作用。
- 本轮及初始化阶段不创建空业务目录、通用框架或第二模板；云账号、好友、订阅、多 Agent、实时协作、后台任务和生成 App 部署均不在首版范围。

## 工作与交付

- 流程：理解需求与现状 → 明确验收 → 最小实现 → 针对性验证 → 审阅交付。强度与完成标准见 [CONTRIBUTING](CONTRIBUTING.md)。
- 源码和检查脚本的修改优先委派给当前 Harness 可用的实现子代理或等效执行角色（`coder` 是角色称呼，不是必需工具名）；主 Agent 负责设计、审查、验收与用户沟通。每个文件同时只有一个写入者；没有委派能力时注明限制，由当前 Agent 按相同流程串行完成，不要求为此安装或切换到 Codex。
- 当前可用：`node scripts/check-docs.mjs`、`pnpm check`、`pnpm build`、`pnpm baseline:selftest` 及 diff 检查。文档检查只验证入口、链接和空白；离线基线自检不是产品验收。真实模型、sandbox live 与发布需相应授权。
- 不 reset、自动 stash、覆盖无关文件或改写历史；不默认提交、推送、发布、部署。新建分支先遵循用户或当前 Harness 的明确命名要求；没有约定时使用 `agent/<topic>`，已有分支无需改名。
- 交付必须说明改动路径、行为/约定变化、实际命令及结果、未运行原因、未实现项。区分静态检查、实际运行与用户接受；不通过删断言或改固定验收制造通过。

- 比赛范围、排期和固定用例以 [任务计划](docs/plans/2026-10-os2026-task-plan.md) 为准。公开资源和 guest 浏览器另遵守各自合同；本地新增 profile 的实现与验收边界见下文及[本次整合记录](docs/acceptance/mota-integration-20261015/README.md)。

## Electron 宿主中的窗口测试

macOS 上的 Electron IDE/Harness 可能向终端继承 `ELECTRON_RUN_AS_NODE=1`，使 Playwright 启动 Electron 时因 `bad option: --remote-debugging-port=0` 失败。先 `pnpm build`，再仅对子进程清除此变量：

```sh
env -u ELECTRON_RUN_AS_NODE pnpm exec playwright test
```

这不修改项目或系统配置，不关闭 Electron sandbox，也不启用真实模型或 sandbox live。失败记录与清理环境后的独立复跑应分别保留。

## 外部 edu-web 接入与定向复验

本任务新增的是用户选择源码的 `edu-web` profile v1，不是第二个内置模板。入口及限制见 [当前运行时](docs/architecture/current-runtime.md)。Main 原生选择 Git 根目录；renderer 不传宿主路径。导入上限仍为 256 文件、524288 字节；后端、依赖锁及构建配置固定于导入基线，启动/导出只接受 `admin/src/` 内的变化。

```sh
pnpm exec vitest run packages/protocol/src/edu-app.test.ts apps/service/src/edu-helper.test.ts apps/service/src/app-service.test.ts apps/desktop/src/main/workbench/edu-source.test.ts apps/desktop/src/main/workbench/edu-source-git.test.ts apps/desktop/src/main/workbench/source-export.test.ts apps/desktop/src/main/workbench/managed-app.test.ts apps/desktop/src/main/workbench/managed-app-host.test.ts
pnpm build
```

真实 guest/Electron 复验需另获授权：准备任务独占、无宿主挂载的 `wsl-edu-...` sandbox，已安装 guest Python 3.12（本任务实测 3.12.3）和锁依赖所需网络。`e2e/edu-app-live.spec.ts` 仅在 `WSL_EDU_LIVE=1` 时执行，还需 `WSL_SBX_NAME`、`WSL_EDU_SOURCE_ROOT`、`WSL_EDU_EXPECTED_SHA256` 和全新的绝对路径 `WSL_EDU_EVIDENCE`；可用 `WSL_EDU_PROFILE` 将全新私有用户数据目录留在证据目录之外。目录选择响应由测试自动提供；Main、service、guest 和原生 Browser 不 mock。测试不调用模型/Azure，不证明实际麦克风或签名包验收；跳过不能计作通过。

## 外部 mota-web 接入与定向复验

`mota-web` profile v1 使用用户选择工程的隔离副本，不增加内置模板。沿用原生目录选择、静态预览、摘要绑定确认和可核对的导入取消/重试；renderer 不传宿主路径，预览不运行脚本或连接 guest。魔塔预算为最多 512 文件、总计 64 MiB、单文件 12 MiB；不沿用 edu 的 512 KiB 总量，也不扩大标准导出预算。

一个受管 App 提供 `appPage: game/editor` 两个稳定资源，分别是 `/index.html` 和 `/editor.html`。关闭视图不停止 App；停止/重启须同时处理两页的实例租约与正确 URL。受限服务的手动保存只允许 `project/floors/MT1.js` 与 `_server/config.json`，其他源码保持导入基线；不执行来源工程的服务或安装脚本。当前已接显式授权的四个 Mota 专用工具，任意 AI 改码、标准 App 控制工具和源码导出仍不支持；手动保存与受限地图操作均不生成标准 P0 D 的 Agent-run diff。既有手动接入结果见[上一阶段整合记录](docs/acceptance/mota-integration-20261015/README.md)，新能力和待验证项见[AI 阶段验收](docs/acceptance/mota-ai-20261015/README.md)。

`e2e/mota-app-live.spec.ts` 默认跳过，只有明确授权真实 guest/窗口验证后才设置 `WSL_MOTA_LIVE=1`。当前用例固定已有、无宿主挂载的 `wsl-sbx-smoke-20261006`，需预先可用的 guest Node/Python 3；测试不安装工具或调用模型。先构建，下面的占位摘要必须换成已独立核对的 Mota profile `sourceSha256`（按逐文件清单计算，不是任意目录摘要）：

```sh
pnpm build
env -u ELECTRON_RUN_AS_NODE -u WSL_OBSERVATION_ROOT -u WSL_SSH_HOST -u WSL_SSH_ROOT \
  WSL_E2E_TARGET=build WSL_MOTA_LIVE=1 \
  WSL_SBX_NAME=wsl-sbx-smoke-20261006 WSL_SBX_BIN=/opt/homebrew/bin/sbx \
  WSL_MOTA_SOURCE_ROOT=/private/tmp/mota-source-copy \
  WSL_MOTA_EXPECTED_SHA256='<已核对的64位小写十六进制摘要>' \
  WSL_MOTA_PROFILE=/private/tmp/mota-private-profile-new \
  WSL_MOTA_EVIDENCE=/private/tmp/mota-evidence-new \
  pnpm exec playwright test e2e/mota-app-live.spec.ts --workers=1
```

源码须为 `/private/tmp/` 下已有的真实隔离副本，不能是符号链接、Downloads 原件或原工作树。所有路径须绝对；profile/evidence 必须尚不存在、父目录已存在，且互不包含，测试会分别排他创建。`WSL_SBX_BIN` 可改成已核验的绝对路径。打包目标还须设 `WSL_E2E_TARGET=packaged`、`WSL_E2E_APP_PATH`（待验 `.app` 绝对路径）、`WSL_MOTA_RUNTIME`（已独立核验的 runtime 描述绝对路径）和 `WSL_MOTA_RUNTIME_SHA256`；runtime 必须对应同一 binary/sandbox、无本地或 SSH 根、处于 ready 且无待办/错误。测试只把核验后的 runtime 原字节复制到全新 profile，不合成 ready、不改 provider/凭据标记，也不复制旧 profile 或 Cookies。这不证明 Setup UI 安装流程通过。

原生目录选择器的响应由测试自动提供；Main collector、service、guest、Browser、编辑器保存和游戏输入走真实通路。用例检查副本文件摘要、游戏刷新效果、所属进程/端口停止与重启，并保留失败。它不覆盖模型/AI、手动编辑的 D diff、导出、实际麦克风、Azure 或其他 sandbox。上一阶段结果仅适用于其记录的构建；新代码须另行复验，跳过不计为通过。

### Mota 受限 AI 任务

沿用 Session 的 `confirmTask`/`startRun`，必须明确选择当前项目运行中的 game 页，并勾选 `app.mota.play`；`app.mota.map.write` 额外依赖 play。UI 默认无授权，取消 play 同时清除 map grant；Main 重核冻结的 workspace/project/AppInstance/run/session/Browser/文档身份，不能从 renderer、模型文字或旧版本推导权限。Mota 无需 DOM 元素采集，不能沿标准 App 路径授予任意 UI 或代码写入。

原生 MCP 只暴露 `app_mota_state`、`app_mota_act`、`app_mota_map_read`、`app_mota_map_set`。每轮新建只读 Codex scratch，不包含工程源码，不 resume 旧可写线程，不安装 `wsl-app` CLI 回退。状态由 Main 固定只读投影；操作通过真实 CDP 输入。地图写入只允许 MT1 空格 `0→53`，使用 expected hash、单一写入者和操作回执；与编辑器保存互斥，版本冲突要求重新加载。取消等待所属模型、工具和租约清理，不删除已确认修改，不据模型停止推断地图操作已结清。

`e2e/mota-agent-live.spec.ts` 只验证当前 build，默认跳过；`WSL_MOTA_TOOLS_LIVE=1` 与 `WSL_MOTA_MODEL_LIVE=1` 必须二选一。前者用测试注入替代模型轮次，仍经过实际产品 dispatcher、CDP 和受管服务；后者走真实产品会话和模型。两种模式均用临时源码、独立 profile/evidence；真实模型还需已核验的既有 guest 模型连接，不新增凭据或以 ready 状态代替实际模型回执。

以下为无模型工具阶段的显式命令；运行前须已有相应授权、当前构建和独立核对的源码摘要：

```sh
env -u ELECTRON_RUN_AS_NODE -u WSL_OBSERVATION_ROOT -u WSL_SSH_HOST -u WSL_SSH_ROOT \
  WSL_E2E_TARGET=build WSL_MOTA_TOOLS_LIVE=1 WSL_MOTA_MODEL_LIVE=0 \
  WSL_SBX_NAME=wsl-sbx-smoke-20261006 WSL_SBX_BIN=/opt/homebrew/bin/sbx \
  WSL_MOTA_SOURCE_ROOT=/private/tmp/mota-source-copy \
  WSL_MOTA_EXPECTED_SHA256='<已核对的64位小写十六进制摘要>' \
  WSL_MOTA_AGENT_PROFILE=/private/tmp/mota-tools-profile-new \
  WSL_MOTA_AGENT_EVIDENCE=/private/tmp/mota-tools-evidence-new \
  pnpm exec playwright test e2e/mota-agent-live.spec.ts --workers=1 --grep 'scripted no-model'
```

真实模型阶段改为 `WSL_MOTA_TOOLS_LIVE=0 WSL_MOTA_MODEL_LIVE=1` 和 `--grep 'real built-in Mota AI'`，同时使用另一组全新 `WSL_MOTA_AGENT_PROFILE`/`WSL_MOTA_AGENT_EVIDENCE`；不得复用工具阶段记录。路径、指定 sandbox、原件保护与原生 picker 自动响应约束沿用上文；该 AI 用例不支持 packaged，不接受凭空生成 ready 记录。2026-10-15 tools03 和独立 model03 均已通过普通/金币两次新局的 MT4 路线、`hero.money` 7/14 与所属清理。model03 使用 build03、真实原生 MCP，未替代模型进程；两局 59/61 次调用、各 12 个有序检查点通过。及时捕获的独立回执完整，但后续 UI 聚合记录触发上限，不能宣称永久历史完整。完整命令、输入摘要、tools01/02 与 model01/02 失败及未覆盖项见[本阶段验收](docs/acceptance/mota-ai-20261015/README.md)。只读 Codex OS 探针因缺少 `--permission-profile` 在执行探针代码前退出，不能将 canary 未变或外层传输 exit 0 解释为写入/网络阻断有效；模型路线通过也不补足该 OS 隔离证据。

验收必须绑定构建：model03 证明 build03 上的真实模型路线，之后仅含退出/启动诊断修复的 build04 不能表述为已重跑模型。build04 默认 E2E02 已有 168 通过、22 跳过、0 失败的独立回执；默认 E2E 首轮 6 项失败、诊断修复及 R3 独立复跑仍分别保留。R3 在最终全套通过不证明先前失败根因或已有焦点产品修复。详见[本阶段验收](docs/acceptance/mota-ai-20261015/README.md)。

不要将 profile、Cookies、guest 数据库或临时凭据加入证据提交。`pnpm check` 在旧 VS001/来源档案的 lint 错误处停止时，应保留原字节，分别执行类型、当前变更 lint/格式、`pnpm test`、构建和 `pnpm baseline:selftest`，不要降低检查规则。

本机曾在 `pnpm test` 与类型检查/Electron 并行时触发 observation-application 的 64-request budget 用例 5000ms 超时；无并行重跑原命令通过，但根因未确认。后续全量测试先单独运行并保留失败，不提高超时或减少预算断言以制造通过。

R2 全量回归又出现两项 Mota 进程握手轮询超时，独立 49 项通过；当时宿主负载较高，但不能据此断言已排除所有其他原因。经用户批准，`mota-server.test.ts` 与既有 observation/MCP/PTY 分组一样，在普通套件之后单独执行；原断言、1000ms 默认轮询预算、用例数和重试策略不变。调度回归验证各文件只被一个项目收集，避免移出普通组后漏跑；不把调度隔离写成 Mota 生产协议修复。

## Linux guest 清理回归

独立的 [Linux workflow](.github/workflows/linux-guest.yml) 配置为在 pull request、main push 和手动触发时运行，不使用签名发布流程。工具链为 Node 24.21.0、pnpm 10.34.6、Python 3.12；日志记录真实 runner 架构。Ubuntu runner 或本地 Linux 容器的结果只证明该环境内的 helper/进程回归，不代替实际 sbx guest、真实模型或产品验收。

```sh
node --test scripts/check-linux-guest.test.mjs
pnpm test:linux
```

`test:linux` 运行整个 `guest-workspace.test.ts`，随后检查 `test-results/linux-guest.json`。必跑清单固定在 [报告门禁](scripts/check-linux-guest.mjs)：非零退出后的完整清单与目录移除、符号链接拒绝、合成清理确认失败时保留副本，以及 close/EOF 两条真实后代进程回收路径。任何测试失败、跳过、todo、`NOT_RUN`、报告缺失或必跑用例缺失都不能通过；Linux `/proc` 身份不可信时也不能放行，不默认使用 `--pid=host` 绕过。

普通 macOS 单测仍保留五个 Linux 用例的跳过标记；`test:linux` 会拒绝这种报告。可移植签名/透传回归不受平台跳过影响，报告门禁的负例也纳入默认 `pnpm test`。修复前失败与修复后结果应分别保存，不覆盖历史记录。

## R2 冻结输入与默认 E2E

[修订计划](docs/plans/2026-10-16-post-review-update-plan.md) 明确先修复、后验收和授权合并；多 Harness、SSH 等仍为条件性后续范围。[冻结清单](scripts/frozen-inputs.json) 固定 14 个文件的路径、来源提交和 SHA-256。检查需要能读取 `b5531e1ac3b3da7adf000f6ba61f2c5b19a0755f` 与 `d91701382e5e8950d695e9ef21fa521043407660` 的 Git 对象，缺失时明确失败，不从工作树重算期望值。CI 使用完整历史；后续集成需保留固定来源的可获取性。

`pnpm check` 先运行 `check:frozen` 和文档检查，再执行类型、lint、格式、离线测试。新增风格例外只针对冻结路径，其他规则不变；旧失败及其原字节继续保留。此门禁不宣称冻结整仓所有历史档案，根 `package.json` 仍是可维护命令入口；不要混用旧 VS001 整体指纹。

```sh
pnpm test:e2e:prepare
pnpm test:e2e
```

准备步骤显式安装模板锁依赖；globalSetup 只核对实际安装树、锁文件、安装回执及 tsx/esbuild，不安装或更新。默认 E2E 启动器只对子进程清除 `ELECTRON_RUN_AS_NODE`，为每轮创建 `test-results/e2e-runs/run-*/`，保留日志、错误上下文、截图、报告及逐项跳过原因，核对运行前后的源码/构建指纹。不要在 E2E 运行时编辑或重建输入。`--list` 是 `not_run`；缺报告、全部跳过、flaky 或输入漂移不是通过。显式 live 配置不会被入口擅自改写，执行前仍须核对本轮授权，不继承旧授权来运行模型或 guest。

[macOS workflow](.github/workflows/validate.yml) 将完整检查、自检、显式模板准备、构建和默认 E2E 串行执行，独立于签名发布流程；失败产物与跳过清单上传为独立 artifact。配置不等于线上执行，Node/macOS 默认套件不替代真实 sbx/model、packaged 或用户接受。

pnpm 布局下，测试若复用 Vite 的 esbuild，应先解析 Vite 的实际包路径，再从该路径创建 `require`；不要拼接逻辑 `node_modules/vite/package.json` 来解析其传递依赖。原生焦点测试需要已解锁的交互桌面，锁屏时保留失败并请求用户解锁，不修改系统锁屏策略。DevTools 的窗口销毁可能早于所属页面的原生连接关闭；窗口已销毁但 `devToolsWebContents` 仍指向旧前端时，重开必须等待 `devtools-closed`，合并重复请求并在预览销毁时撤销等待。诊断应同时记录所属网页、活动窗格和原生内容状态；锁屏导致的无焦点是另一类环境阻塞，不能解释此前有聚焦窗口的空前端失败。

packaged 入口除工作区构建外，还核对所选 `.app` 的路径、实际路径、文件内容摘要、权限、目录清单及内部符号链接；流式计算文件哈希，不跟随越界链接。缺失、不完整或包含越界链接的输入不能启动测试；产物漂移不能凭绿色测试报告放行。合成 bundle 回归只证明指纹门禁，不证明真实安装包、签名或公证验收。

## R3 App 完成链回归

`apps/service/src/app-service.ts` 单文件启用类型感知 `no-floating-promises`（`ignoreVoid: false`）与 `no-misused-promises`；另有精确语法门禁防止裸 `then(async success, onRejected)` 把成功回调的拒绝留在返回链上。`node --test scripts/check-app-promises.test.mjs` 验证正反例与作用域，不能以 `void` 代替处理拒绝；静态通过也不能证明 catch 回调绝不会抛错。

App 生命周期回归位于 `app-service.test.ts` 的 `R3 App asynchronous completion failures` 分组。必须区别正常退出结果、拒绝的完成 Promise、清理确认与持久化成功。拒绝不提供退出证明；已有确认也不因磁盘失败被抹去。退出完成链与显式 stop 使用各自句柄并串行衔接，不能让共享 Promise 跳过有限 helper 取消。检查迟到实例、落盘期间失去映射连续性、清理/通知异常及显式恢复；通知失败至少保留同进程可查询错误，不据此宣称磁盘记录成功或 Mota 未确认租约已经释放。

## R4 Mota 违规与能力门禁

固定版本来自 `DependencyManifestSchema` 的 guest Codex 合同（0.160.0）。当前没有验证其 `exec` 原生工具限制，`SbxConnection.assertMotaCapability()` 因而对所有版本拒绝 Mota 模型启动；没有配置/环境变量绕过。service 的具名 pre-model 拒绝在租约 acquire 和 `chat.send` 之前发生，直接 chat/send 与底层启动也检查。上述 model03/live 命令是历史流程，不代表本树可以启动或自动取得新授权；启用需要独立核验固定二进制及实际原生工具集，不能根据 `sandbox` 子命令错误添加产品 `exec` 参数。

定向回归入口：`pnpm exec vitest run apps/service/src/codex-mota-policy.test.ts apps/service/src/codex-chat.test.ts apps/service/src/sbx.test.ts apps/service/src/index.test.ts apps/service/src/resource-mcp.test.ts apps/desktop/src/main/workbench/mota-managed-app.test.ts`。合成事件/进程测试显式 mock 门禁，不构成真实能力证明。Mota MCP 必须只列出且只接受四个专用工具，资源读取亦不例外；其他模式继续保留资源工具。

违规检测覆盖三个 item 阶段，关闭入口必须先于后续 dispatcher 调用；取消信号需要传播到在途操作。Main 在清理等待中可以显示 cancelling，但 `policy_violation` 的最终状态必须 failed，即使用户同时点击停止。未确认的模型、原生输入或租约继续占用；清理诊断不能覆盖违规原因，既有合法地图回执继续保留。事件检测不等于执行前审批，工具门禁不等于 OS 文件/网络隔离。
