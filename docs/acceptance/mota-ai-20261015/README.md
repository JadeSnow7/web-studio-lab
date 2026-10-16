# 2026-10-15 魔塔受限 AI 操作验收

状态：2026-10-15 的 model03 已通过真实模型 7/14 验收：build03、原生 MCP、未替代模型进程，普通/金币两次新局均到 MT4，money7/14、各 12 个有序检查点通过，所属资源清理确认。此前 tools03 无模型工具验收和 manual01 的 build02 手动编辑复验也已通过；tools01/02、model01/02 的失败仍独立保留。默认 Electron E2E 首轮 162 通过、22 跳过、6 失败；诊断及测试修正后，build04 默认 E2E02 为 168 通过、22 跳过、0 失败。R3 先前失败根因仍未定；model03 不表示 build04 已重跑模型。逐条捕获的模型工具回执完整，后续 UI 聚合输出仍触发上限；OS 写入/网络隔离未证实。代码存在、单元测试通过或模型文字声称完成，均不能替代实际游戏状态与独立验收。

此前导入、手动编辑、药水效果及受管生命周期的结果保留在[上一阶段整合记录](../mota-integration-20261015/README.md)，不改写为本阶段 AI 证据。本阶段继续使用 `agent/mota-preparation-20261015` 隔离树，不修改魔塔 Downloads 原件、原来源工作树或现有 edu 服务；没有提交、推送、签名或发布动作。

## 能力与授权范围

空间会话沿用确认任务、发送、任务版本、运行记录和取消入口。目标必须是当前项目、当前运行 App 的游戏页，不能选择编辑器或其他工程。任务确认由 Main 冻结真实 Browser/文档/运行身份，不依赖页面自报或任意 DOM 元素捕获。

- “允许 AI 操作游戏（含重新开始）”对应 `app.mota.play`，默认不授予。确认和启动 Mota 任务都要求明确选中它；不提供隐含的只读模型模式。
- “允许 AI 在一楼空格放置幸运金币”对应 `app.mota.map.write`，额外依赖前一项。撤销游戏操作权限同时撤销地图写入；重新选中游戏操作不能自动恢复地图权限。
- 授权保存到会话 `taskAllowedScopes` 并冻结进任务版本。修改草稿权限不扩大旧版本的权限；旧版本、迟到事件与已撤销租约须重新核对。
- 游戏操作只通过受限状态和动作工具，动作是游戏实际接收的点击/按键、文本对话继续及新局。不能注入任意脚本、调用内部移动/回放函数、赋值角色数值或伪造路线。
- 地图写入仅允许导入副本 `MT1` 的空格 `0` 改为幸运金币 `53`；要求来源版本、操作身份和前后散列回执。无任意文件或任意代码修改权限。AI 地图操作与编辑器保存互斥；版本冲突后先重新加载，不覆盖较新内容。
- 游戏/编辑器仍是同一 App 的两个资源。关闭视图不停止 App；取消 AI 运行不宣称清除了已保存地图。原件不回写，源码导出仍不在本阶段范围。手动编辑不属于 P0 D 的 Agent-run diff；本阶段地图写入以独立操作回执举证。

当前专用工具为原生 MCP 的 `app_mota_state`、`app_mota_act`、`app_mota_map_read`、`app_mota_map_set`，Main 内对应 `app.mota.state/act/map.read/map.set`。每轮 Codex 使用新的只读 scratch，不复制工程源码、不 resume 旧可写线程，不提供 `wsl-app` CLI 回退。Main 以固定只读投影获取状态，经真实 CDP 输入执行受限动作；地图操作使用 expected hash、唯一写入者、操作身份及前后散列回执。标准 App 控制能力、任意代码/楼层修改和标准 D 源码 diff 均不开放。详细接线见[当前运行时](../../architecture/current-runtime.md)，UI 行为见[交互契约](../../../UX-CONTRACT.md)。

协议来源：[mota-control.ts](../../../packages/protocol/src/mota-control.ts)。实现和测试须覆盖未授权、缺少游戏目标、错误项目/实例/文档、编辑器并发保存、旧版本、重复操作、取消及清理未确认；不能只验证成功路线。

## 固定路线与预期

两组都从真实新局开始，不读取旧存档、不继承上一局的角色状态。普通组先运行并记录地图未修改；金币组只在副本 MT1 `(6,10)` 的空格放置幸运金币，再按产品支持的刷新/新局流程使游戏读取该修改。

路线由[固定路线与工具驱动](../../../e2e/mota-agent-live-helpers.ts)维护；每次实际运行前须记录该文件、产品构建、导入 manifest 与源码摘要，不能在失败后悄悄换路线或改预期。关键经过点为：

1. MT1 从 `(6,11)` 出发，经过 `(6,10)`，取 `(5,10)` 黄钥匙、开 `(6,9)` 黄门，走右侧走廊到顶行，依次经过 `(5,1)`、`(4,1)`、`(3,1)` 三个怪物，再从 `(1,1)` 上楼。
2. MT2 自然落点 `(1,2)`，沿左侧到 `(1,11)` 上 MT3；从 MT3 `(2,11)` 经 `(5,11)` 到 `(5,9)` 触发伏击，等待剧情自然返回 MT2 `(3,8)`。
3. 按原剧情先与 MT2 `(3,7)`、再与 `(1,9)` 的小偷交谈，回 MT3；收集指定九宫格，经过 `(7,5)` 绿史莱姆、`(8,10)` 红史莱姆，开 `(9,11)` 黄门，至 `(11,11)` 上 MT4。

只在工具确认文本对话可继续时发送 continue；忙态等待真实稳定回执。采用有限工具预算，不通过提高预算或直接修改游戏状态制造成功。

| 组别     | 地图条件                         | 最终位置      | `MotaState.hero.money` | `MotaState.hero.coin` |
| -------- | -------------------------------- | ------------- | ---------------------- | --------------------- |
| 普通新局 | MT1 基线空格保持 `0`             | MT4 `(11,10)` | 7                      | 0                     |
| 金币新局 | 仅 MT1 `(6,10)` 从 `0` 改为 `53` | MT4 `(11,10)` | 14                     | 1                     |

`money` 是原游戏 `core.status.hero.money`，不是统计面板或模型回答中的数字。需保留各阶段真实状态与最终截图，核对地图前后原始字节/散列及唯一改格回执；不能仅凭截图文字或工具调用数量判定成功。

## 分阶段执行与证据

1. **静态与确定性回归**：协议、授权、Main/Host、service、版本写入、取消和 UI 呈现分别检查。限定检查结果不能代表 Electron 窗口或真实模型通过。
2. **scripted-no-model**：测试驱动实际产品内的同一 run-scoped 工具通路，在原生 Browser 中完成普通/金币两条新局路线。测试仅替代模型执行部分，须保留产品授权、租约取得/释放、dispatcher、service、guest 和实际游戏输入；最终注入边界随证据明确记录。允许原生目录选择响应由测试自动提供。该阶段只能证明工具与接线，不证明模型会完成路线。
3. **real-model**：通过现有会话确认/发送路径，把冻结路线与授权交给真实模型；保留模型、工具和游戏状态证据。普通与金币分别新局，按上表验收。若只完成 scripted，必须明确真实模型仍未通过或未运行。
4. **清理与完整性**：核对本次精确 App/运行/进程/端口及租约清理，未知状态保持可见；不得停止整个共享 sandbox 或影响 edu。比较宿主原件及冻结输入前后摘要，确认只修改本次 guest 副本的获准地图格。

本阶段初始只读 sbx 检查曾因本机沙箱 IPC 限制失败；经获批的只读复核成功，记录为 smoke sandbox 停止、0 挂载、0 会话，edu sandbox 运行、1 会话且不操作。该结果只是环境基线，不证明本阶段游戏或模型可运行。沿用现有配置，不新增或读取凭据内容。

每次尝试保存独立记录：模式、UTC 起止时间、输入/构建摘要、实际命令和退出码、目标身份、工具回执、地图摘要、截图、失败点与清理结果。失败保留原样；修复后的重跑新建记录，不能用后续成功覆盖先前失败。私有 profile、Cookies、凭据和模型配置正文不纳入可提交证据。

## 显式运行入口

本阶段入口为 [mota-agent-live.spec.ts](../../../e2e/mota-agent-live.spec.ts)，只接受当前 build，默认跳过。`WSL_MOTA_TOOLS_LIVE=1` 与 `WSL_MOTA_MODEL_LIVE=1` 必须二选一；两组分别使用全新的 `WSL_MOTA_AGENT_PROFILE` 和 `WSL_MOTA_AGENT_EVIDENCE`，不能复用旧结果。还需独立核验的 `WSL_MOTA_SOURCE_ROOT` / `WSL_MOTA_EXPECTED_SHA256`、指定已有 sandbox 与 sbx 路径。路径和原生 picker 自动响应约束、完整命令见根 [AGENTS](../../../AGENTS.md)。真实模型阶段沿用已经核验的 guest 连接；探针可用或配置 ready 不等于模型通过。测试命令列出不表示已执行。

## 已验收范围与剩余边界

- real-model 的 model03 已独立通过固定 7/14 路线与清理，使用 build03、全新 profile 和明确检查点的提示词。model01/02 仍为失败，不由后续成功改写；tools03、manual01 与 model03 各自只证明其记录范围。
- 独立 OS 探针未进入命令沙箱，写入/网络阻断尚未验证。签名包、Setup UI、用户接受、任意代码修改、源码导出、标准 D diff、实际麦克风、Azure 及其他平台均不能从本轮工具路线推导。
- README、AGENTS、当前运行时与 UX-CONTRACT 已同步工具与真实模型 live 结果；UI 聚合历史受记录预算限制，不保证永久完整回执。默认 E2E 首轮失败与修复后 build04 的完整复验通过分别记录，不能用限定 live 通过替代全量回归。旧阶段“仅手动”的记录保留为历史。
- 未完成检查、失败、跳过、清理未知和未覆盖范围须在最终结果中分别列出，不能以“整体通过”合并。

## 工具 live 实测与失败链

本地原始证据根为 `/private/tmp/wsl-mota-preparation-20261015/ai-stage/evidence/`，未将私有 profile、Cookies 或模型配置加入仓库。以下时间为外层命令回执的 UTC；每轮独立的 `tools-live-0N.json/.log` 与 `tools-0N/result.json` 保留原样。

| 尝试    | UTC 起止          | 结果           | 已证实与失败点                                                                                                                                                                             |
| ------- | ----------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| tools01 | 12:21:14–12:24:12 | exit 1，failed | 普通组开始游戏返回 `app_busy`（开始按钮尚未进入游戏），尚无路线检查点；所属运行、App、进程与端口清理确认。之后修正真实新局就绪等待，保留原 8 秒上限及状态断言。                            |
| tools02 | 12:29:25–12:32:56 | exit 1，failed | 普通组 53 次调用、12 个检查点，到 MT4，money 7；第二轮填写已保存草稿时精确标签定位超时，金币组未开始。随后只修测试的已保存版本选择与稳定输入定位；产品授权、确认及启动断言不变。清理确认。 |
| tools03 | 12:40:36–12:44:18 | exit 0，passed | 两组路线与清理全部完成，`failures: []`；结果文件内记录为 12:40:38.542–12:44:18.681 UTC。                                                                                                   |

tools03 的实际命令由 `tools-live-03.json` 保存：在当前 Lab 目录运行 `env -u ELECTRON_RUN_AS_NODE -u WSL_OBSERVATION_ROOT -u WSL_SSH_HOST -u WSL_SSH_ROOT -u WSL_MOTA_MODEL_LIVE`，设置 `WSL_E2E_TARGET=build`、`WSL_MOTA_TOOLS_LIVE=1`、既有 smoke sandbox 和 sbx 路径、冻结来源及独占的 `profile-tools-03` / `evidence/tools-03`，执行 `pnpm exec playwright test e2e/mota-agent-live.spec.ts --workers=1`。原生目录选择响应自动提供；测试包装仅替代 Codex 进程，真实 service send/register/acquire、权限、dispatcher、CDP 和地图保存保留。该模式没有原生 MCP 或模型执行证明。

| tools03 实际组别 | 工具调用 | 路线检查点 | 终点          | HP  | money | coin |
| ---------------- | -------- | ---------- | ------------- | --- | ----- | ---- |
| 普通新局         | 53       | 12         | MT4 `(11,10)` | 926 | 7     | 0    |
| 金币新局         | 55       | 12         | MT4 `(11,10)` | 926 | 14    | 1    |

两组最终 atk/def 均为 10，黄钥匙 4、蓝钥匙 1，移动与剧情忙态均已结束。独立地图回读及工具回执确认只将 MT1 `(6,10)` 的 `0` 改为 `53`；操作 `b38b2d77-76d4-458f-83a8-8185d89d538b` 的 before SHA 为 `b700c9fe6d918b813c46ee6826b918ae7d83bb3171851ad327d57ff84bc31ce6`，after SHA 为 `446222f0dfd824beb4de5fb844a5de7073d0c9d485947be9156d36ecccffa04a`。普通组保留 before SHA。

本次 AppInstance 为 `89f5b566-6f5d-44a2-8217-382ef0e1ad84`，普通/金币 run 分别为 `6bc52cde-408e-4beb-8e6b-ab7004157377`、`c43add26-2e86-4024-929c-5f81c584ac2b`。路线完成后测试取消两 run，最终均为 cancelled，模型、App 和 Mota cleanupPending 均为 false；这表示所属执行已清理，不将路线通过改写为模型自然完成或用户接受。App 最终 stopped 且 cleanupConfirmed；Electron PID 50613 以 0 退出，guest 所属进程 `remaining: []`。新增 `127.0.0.1:49425→39653` 映射已删除，原基线 `49421..49424→8081` 全部保留，测试 keeper PID 50413 退出确认。

导入 profile 的 `sourceSha256` 为 `4b2a8d996de4797141cef530f7622b08fca1ae7863d1a3a761d87e98f20216ad`。临时输入目录的完整文件审计为 322 文件、SHA `7bb69d357a2b2a1a31086f02ae05242529386c103cecbd48a0920e8e1d00bc0c`，前后一致；该目录审计与 profile 清单摘要口径不同。此用例明确不覆盖 Downloads 原件，不能将临时输入未变当成原件前后复核。`tools-03/result.json` 自身 SHA 为 `b764f48da87787839f487600e50372b7583b97c36610effa422953c78ba5b00a`。

## build02 的手动编辑复验

`manual-live-01.json/.log` 记录 12:51:19–12:54:38 UTC 执行 `WSL_MOTA_LIVE=1` 的 `e2e/mota-app-live.spec.ts --workers=1`，exit 0；`manual-01/result.json` 为 passed，failures 与 cleanupErrors 均为空。该次使用 build02、全新私有 profile 和相同冻结临时输入，包含新增编辑器防护；实际编辑器、服务、guest 与 Browser 不 mock，原生目录选择响应自动提供。

编辑器将 MT1 `(6,10)` 从 `0` 改为药水 `31`，独立 guest 回读确认文件仍为 2982 字节，SHA 从 `b700c9fe6d918b813c46ee6826b918ae7d83bb3171851ad327d57ff84bc31ce6` 变为 `cbdfeb44e7a4b18d72f755d20a469c21c07308142e60bc29e1695f82392f8562`。重新加载并点击开始后，新局从 HP1000 出发，实际向上拾取药水变为 HP1050；离开后再次经过仍为 HP1050，没有第二次拾取。关闭视图不停止 App；停止、重启、游戏/编辑器两页重绑定及保存内容保留均通过。

最终 App stopped、cleanupConfirmed，guest 进程列表为空、Electron exit 0；本次新增的 `49435→45359` 和重启的 `49436→38277` 映射已清理，基线 `49431..49434→8081` 保留，keeper 退出确认。临时输入前后 SHA 均为 `7bb69d357a2b2a1a31086f02ae05242529386c103cecbd48a0920e8e1d00bc0c`；Downloads 原件不在该用例审计范围。结果文件 SHA 为 `5dfcaeb9607f03ba44bd63a852569c863062bd98d0984be7c55004b1f5a313c3`。这次复验支持当前构建的手动编辑与生命周期，不是 AI 路线、编辑器与 AI 并发锁负例、标准 D diff 或用户接受证明。

## 真实模型首轮失败

`model-live-01.json/.log` 记录 12:47:22–12:50:11 UTC 执行 `WSL_MOTA_MODEL_LIVE=1` 的 `e2e/mota-agent-live.spec.ts --workers=1`，exit 1；`model-01/result.json` 为 failed，`modelProcessReplaced: false`。本次走实际产品会话及真实内置模型，原生 MCP 已连接；首个 `app.mota.state` 的完整回执保存在 `normal-model-tool-1.json`，当时仍在开始界面，floor/hero 均未建立，不能记为已走路线。

随后 newGame 的产品动作审计为成功，但同一完整 Mota envelope 同时出现在 text 与 `structured_content`，工作台记录超过单条 16K 上限后被替换为 69 字符的截断标记，`receipt: {}`。验收在 `uncaptured model tool receipt was truncated` 断言处停止；结果为 capturedOutputTruncated true、已捕获工具回执 1 条、检查点 0，金币组未开始。这是工具证据记录失败，不能把实际开始游戏动作推为普通路线通过，也不据截断记录推断模型原始结果丢失。

后续已对相同完整 Mota envelope 做无损去重，保留单条 16,000 字符 / 每轮 131,072 字符记录预算，不丢字段、不改模型原始结果；限定于通过严格业务 schema 校验、内容完全相同的重复表示。定向回归及 build03 结果见下文，model02 仍按原验收条件独立判定，不能因修复代码存在宣布模型通过。

本轮 run `3567f0fa-2e60-4647-97cb-8529550d20c4` 已取消，模型、App 和 Mota cleanupPending 均为 false；App stopped、cleanupConfirmed，Electron PID 57678 exit 0、guest remaining 为空。新增 `49430→37647` 映射已清理，基线 `49426..49429→8081` 保留；MT1 仍为原始 SHA `b700c9fe6d918b813c46ee6826b918ae7d83bb3171851ad327d57ff84bc31ce6`，322 文件输入审计前后一致。`model-01/result.json` SHA 为 `8b6fa58fb4aefe3366cf3691aef26257f181aab446451ee8318f4bc05cfeddc9`。

## 真实模型第二轮失败与检查点澄清

`model-live-02.json/.log` 记录 13:00:59–13:06:43 UTC 在 build03 上执行相同 real-model 用例，exit 1；`model-02/result.json` 为 failed。真实原生 MCP 留下 57 条逐次完整回执，最后一条 `normal-model-tool-57.json` 确认 MT4 `(11,10)`、HP926、atk/def 10、money7、coin0、黄钥匙4、蓝钥匙1。`capturedOutputTruncated: false` 表示及时采集的独立回执完整；`laterUiOutputTruncated: true` 仍保留，说明后续工作台聚合输出触发了上限，不能表述为所有 UI 历史均未截断。

整体验收在 `missing ordered real-tool checkpoint: thief-first-dialogue` 处失败。`mota-agent-checkpoint-prompt-static-01.json` 对 57 条记录复核：10 个检查点有对应回执，缺少 `thief-first-dialogue` 和 `thief-second-dialogue`。模型确实完成两次小偷对话，但从相邻格直接寻路到下一段，没有在 NPC 原格停下并返回独立 idle 状态。此前提示只要求“交谈”，未明确该证据动作；终点数值正确不能替代这两个既定检查点。原结果的 checkpoints 为空是完整有序验证提前失败，不应改写为已通过 10/12 或普通组已验收通过；金币组未开始。

后续只澄清 `e2e/mota-agent-live-helpers.ts` 的模型提示：每次对话结束后再 tile 到 NPC 原格，取得独立 idle 回执。12 个检查点验证及工具预算保持不变；该文件摘要为 `2574f0c6f062313d883a4ccde9459108234a5234369f5d4cd2283f646bf16d21`，定向格式、lint、E2E 类型检查通过。model03 使用同一产品 build03 和另一全新 profile 重跑，独立通过结果见下文。

run `f0965591-b4a2-4d33-a0ed-be3d480da497` 自然 completed，执行器 idle，模型/App/Mota cleanupPending 均为 false；App 最终 stopped、cleanupConfirmed。Electron PID73800 exit 0、guest remaining 为空，基线 `49437..49440→8081` 保留，本轮新增映射已清理。MT1 基线与 322 文件临时输入摘要均未改变。`model-02/result.json` SHA 为 `9b6393a82459d87ac2301e7a9455bd97db0df707ab0d3e9ee5db478f22ec1bc5`。执行完成与清理确认不改变本轮验收 failed。

## 真实模型第三轮通过

`model-live-03.json/.log` 记录 13:10:40–13:19:29 UTC 的 real-model 命令 exit 0；`model-03/result.json` 为 passed、`failures: []`、`modelProcessReplaced: false`，内层记录时间为 13:10:41.930–13:19:29.017 UTC。使用 build03、同一冻结来源和 `profile-model-03`，通过实际 Session 确认/发送、真实模型、原生 MCP、产品 dispatcher、service 与 CDP 执行；仅原生目录选择响应自动提供。没有替代模型进程或在回执外补写游戏状态。

| model03 实际组别 | 原生 MCP 工具调用 | 有序检查点 | 终点          | HP  | money | coin |
| ---------------- | ----------------- | ---------- | ------------- | --- | ----- | ---- |
| 普通新局         | 59                | 12/12      | MT4 `(11,10)` | 926 | 7     | 0    |
| 金币新局         | 61                | 12/12      | MT4 `(11,10)` | 926 | 14    | 1    |

两组均 atk10、def10、黄钥匙4、蓝钥匙1，结束时移动/剧情忙态解除。原始 `normal-model-tool-*.json` 与 `coin-model-tool-*.json` 分别保留完整 59/61 条回执；两轮 `capturedOutputTruncated: false`，但 `laterUiOutputTruncated: true`。验收依据及时捕获的独立证据，不声称后续 UI 聚合历史或永久记录完整。

金币组第 3 条回执的操作 `6b3d279b-8e38-42da-b71b-b13a94925669` 只将 MT1 `(6,10)` 从 `0` 改为 `53`；before SHA 为 `b700c9fe6d918b813c46ee6826b918ae7d83bb3171851ad327d57ff84bc31ce6`，after SHA 为 `446222f0dfd824beb4de5fb844a5de7073d0c9d485947be9156d36ecccffa04a`。普通组保留基线，金币组从新局加载修改后验证效果。

`model-03-map-diff-derived.json` 是执行后对本次捕获的 `MT1-before.js`/`MT1-after.js` 做的只读派生核验：两个文件的 SHA 逐一匹配 `coin-model-tool-3.json` 的同一操作回执；解析地图并断言唯一改格为 `(6,10): 0→53`，同时保留原始 unified diff。文件大小为 2982→2983 字节。这是本次真实模型地图写入的文件差异与回执证据，不是标准 D Agent-run 源码 diff，也不是重新执行模型。

普通 run `549ab4f0-d3cb-4032-a120-f36ec6acba59` 与金币 run `01cc0294-3142-43d0-b5e6-586c4fd4178b` 均自然 completed、执行器 idle，全部 cleanupPending 为 false。AppInstance `ffe925fb-aea5-4986-ae1e-7c7c10cdbdcc` 最终 stopped、cleanupConfirmed；Electron PID78103、keeper PID78073 均 exit 0，guest remaining 为空。本轮 `49446→36567` 映射已删除，基线 `49442..49445→8081` 保留。322 文件临时输入前后 SHA 均为 `7bb69d357a2b2a1a31086f02ae05242529386c103cecbd48a0920e8e1d00bc0c`；原件和其他 sandbox 不由该输入审计覆盖。

`model-03/result.json` SHA 为 `891035722c47293d96a64f27c5464212184bf87e4bbe43b6b1976d6f6bf26fa8`；外层命令回执 SHA 为 `8c2b82a508be0cd3f13d0c873ca3b211925b94d28c9f276f02e33fabb2398272`。这确认该构建与固定路线的真实模型验收，不自动赋予产品 validation 或用户接受状态，也不扩展为任意任务可靠性、OS 沙箱、签名包或全量 E2E 通过。

## 默认 Electron E2E 首轮失败与诊断修复

`e2e-default-01.json/.log` 记录 13:20:00–13:34:58 UTC，在 build03 上清除所有 live 开关、按 `--workers=1` 执行默认 Playwright 全套，exit 1：162 通过、22 跳过、6 失败；日志另记录 3 项非用例错误，原样保留。失败不由单独的 model03 成功抵消。

| 首轮失败                                                      | 证据与处置                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shutdown：invalid JSON、null sandbox、future version，共 3 项 | 首轮均报 90 秒超时。测试夹具退出清理完善后，旧 build03 的 `shutdown-before-fix-01` 单例于 13:42:36–13:42:40 UTC exit 1，用例耗时 2.3 秒，准确失败在对话框缺少 `app-registry.json` 叶子原因；PID86900 exit 0、stillRunning false、cleanupFailureCount 0。不能把该诊断断言失败写成测试进程仍未清理。 |
| 运行记录菜单的 diff 内容                                      | 菜单及键盘已切入 diff；旧断言期待“真实 diff 尚未记录”，D 事实现为“源码差异不可用／任务未绑定受管 App 工程，无法采集源码差异”。只更新这两个内容断言，保留菜单、焦点、遮挡及超时。                                                                                                                   |
| App 启动失败详情                                              | fixture stderr 已到 service，但通用退出诊断只筛 Mota marker，导致 standard App 详情只剩 exitCode7/cleanupConfirmedtrue。保留原错误详情断言，修复产品诊断，未放宽测试。                                                                                                                             |
| R3 双网页原生焦点                                             | 首轮等待目标 WebContents isFocused 超时。`r3-focus-recheck-01` 于 13:43:14–13:43:21 UTC，在同一 build03、未改断言下单独执行通过；首次失败原因仍未确定，不据复跑通过宣称已定位或修复。                                                                                                              |

退出修复见 `shutdown-diagnostics-collaboration-receipt.json`：保留嵌套 AggregateError/cause 的叶子原因与原错误对象，循环引用不隐藏其他错误；所有清理 owner 仍尝试，失败仍拒绝、修复后可重试。5 项定向测试及局部 lint/格式检查通过；旧构建单例失败与修复后窗口复验分开记录。

启动诊断修复见 `startup-stderr-collaboration-receipt.json`：只对 standard/edu 的非 verification 启动保留最近 4000 字符 stderr，每次新启动重置，不包含混合 stdout 或验证输出；Mota marker、退出/清理事实与映射归属不变。首次定向检查因两个新增测试误用 create API 而 108 通过、2 失败，仅修 fixture 调用后第二次 110/110 通过；service 类型、局部 lint/格式和 diff 检查通过。原窗口错误详情断言保持，并在最终 E2E02 通过。

`e2e-regressions-fixed-01.json/.log` 在 build04 上于 13:46:41–13:47:04 UTC exit 1，9 项中 3 通过、6 失败。运行记录菜单及两个启动状态 UI 用例通过；5 个关停用例均已完成原断言，却在新增测试清理阶段调用已释放 Playwright channel 的 `app.process()` 时失败。仅将测试改为 launch 后立即缓存所属 ChildProcess，`shutdown-cleanup-static-02.json` 的类型、lint、格式和 diff 检查通过。R3 首次焦点断言再次失败，期间没有焦点产品变更；原 `attach(body)` 未被 reporter 持久化，不能声称已取得当时的焦点状态。首次原因仍未定，失败保留。

`e2e-regressions-fixed-02.json/.log` 于 13:49:14–13:49:39 UTC exit 0，8/8 通过：5 个关停用例（包含三个坏 registry 的取消→修复→重试）以及运行记录菜单、启动失败详情、启动中强制关闭后的恢复。5 个所属 Electron 进程均 exit 0、signal null、无清理失败。该组未包含 R3，不能由这 8 项推导全套通过。

`r3-focus-recheck-02.json/.log` 于 13:50:14–13:50:20 UTC 在 build04 上独立通过，exit 0；新增的失败诊断没有触发，不能据此补写此前失败时的焦点状态。

最终 `e2e-default-02.json/.log` 于 13:51:04.094–13:59:40.439 UTC 在 build04 上清除 live 开关、按相同 `--workers=1` 执行默认全套，exit 0：168 通过、22 跳过、0 失败，没有 worker teardown 错误。三个坏 registry 的取消→修复→重试与启动诊断原断言均通过；R3 为全套第 170 项、耗时 4.2 秒。此前失败记录原样保留，R3 先前失败的根因仍未确定，不能把本次通过表述为已经定位或修复焦点产品缺陷。

build04 的生产变化限定于上述诊断修复；`build-fingerprint-04.json` 比较 8 个构建产物，只有 `apps/service/out/index.cjs` 变化，Main、preload 和 renderer 与 build03 逐字节一致。model03 的真实原生 MCP 与 7/14 证据仍只绑定 build03，未在 build04 上重跑模型。测试夹具清理和旧 diff 文案断言调整不改变产品路线，也不替代最终默认 E2E 全套。

## 静态回归与 OS 探针边界

`typecheck-03.json` 和 `lint-03.json` 分别记录 `pnpm typecheck`、`pnpm lint` 退出 0。`vitest-default-03.json/.log` 记录 12:45:58–12:46:43 UTC 在相同默认配置下独立运行 Vitest：131 文件通过、8 跳过；1813 测试通过、18 跳过，耗时 44.12 秒。此前 `vitest-default-02` 与类型/lint/live 检查重叠时出现 4 个 5 秒超时，1809 通过、18 跳过，exit 1；失败保留。独立重跑通过不能证明 CPU 竞争就是根因，也不代表整条 `pnpm test` 或所有 Electron E2E 已通过。

回执去重的 `mota-mcp-dedup-freeze-01.json` 保留首次定向检查 69 通过、1 失败：新 map.set fixture 仅 15,967 字符，没有满足预定“超出单条上限”的前置条件。仅补足 fixture 元数据后，第二次 `resource-chat/codex-chat/sbx` 三文件 72 测试通过，service 类型及局部 lint/格式检查通过；未降低大小预算或业务断言。`build-03.json` 记录 13:00:13–13:00:19 UTC 的 `pnpm build` exit 0。最新 `vitest-default-04.json/.log` 在默认并发配置下独立运行，13:09:28–13:10:07 UTC exit 0：131 文件通过、8 跳过；1835 测试通过、18 跳过，耗时 38.39 秒。该结果与上面的 model03 路线验收分别记录。

`typecheck-04`、`lint-04`、`diffcheck-01` 与 `ui-audit-02` 均 exit 0；UI 审计为 strict/no-write 静态检查，不替代窗口交互。`format-02` 的全量 `pnpm format:check` 仍 exit 1，唯一报告路径是保留原字节的历史 `docs/acceptance/consolidation-20261011/closeout-20261014.md`，不能宣称全量格式通过。

诊断修复后的 `vitest-default-05.json/.log` 记录 13:43:57–13:44:45 UTC，仍以默认配置独立运行、exit 0：131 文件通过、8 跳过；1841 测试通过、18 跳过，耗时 47.36 秒。`typecheck-05` 和 `lint-05` 均 exit 0；`format-03` 仍 exit 1，唯一报告路径仍是上述历史 closeout 文件。`build-04.json` 记录 13:45:40–13:45:46 UTC 的 `pnpm build` exit 0。默认 E2E02 的通过由上述独立窗口回执证明，不由单测或构建推导。

`os-sandbox-probe-01.json` 的外层 sbx 传输 exit 0，但内层 `codex sandbox` exit 2，提示缺少必需的 `--permission-profile`；固定 canary/自身回环测试代码没有进入命令沙箱执行。canary 前后未变、测试进程组退出和目录/监听清理只证明探针自身没有留下资源，不证明只读沙箱阻止写入或网络。`codex exec --sandbox read-only` 是当前产品配置，实际 OS 阻断仍需独立证据；共享 guest 同 UID 文件系统边界不变。
