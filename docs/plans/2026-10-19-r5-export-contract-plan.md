# R5：统一现有导出合同实施计划

状态：**待实施计划**。本次授权是准备下一包计划，不是实施 R5、启动 live 验收或提交代码。后续执行沿用 [AGENTS](../../AGENTS.md)、[开发规范](../../CONTRIBUTING.md)、[架构](../ARCHITECTURE.md)及[评审后修订计划](2026-10-16-post-review-update-plan.md)的 R5 定义。

## 1. 为什么下一包选 R5

地址输入包已完成新的交互桌面对照、默认检查及独立审查，当前候选可以作为下一包的测量起点。R5 有明确的现有合同和可在离线环境检出的差异，适合在 R6 可信编辑入口实施前单独收敛。

这不关闭 R4 原生工具能力/S4 OS 隔离事项，不解除 Mota 模型门禁，也不把地址 E2E 通过解释为整个第一阶段完成。R6 仍按 [ADR-0004](../architecture/adr/0004-mota-trusted-editor-save.md)另包处理。四项历史单测根因仍为 undetermined；本包收集新失败事实，不修改取消状态机、Python 隔离或 edu/Mota collector 的实现和门槛来制造通过。

## 2. 起点与输入保全

| 项目                   | 执行起点                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 仓库/工作树            | `JadeSnow7/web-studio-lab`；`/Users/huaodong/workspace/_worktrees/wsl-review-fixes-20261016`                           |
| 分支/HEAD              | `agent/refactor-modular-20261017`；`e6bb391df4c1d6c0c6a884d6acdc4061e3027b3b`                                          |
| 计划新增前的已验收候选 | 原 7 个候选文件 + 地址修复的 7 个源码/测试文件，均未提交；不是干净 HEAD                                                |
| 该候选源码指纹         | 5183 个输入，aggregate `0b4273798c00011a8ac40cdfb3f0f658da6e7e70bf451effe437e6e9c6240157`                              |
| 该候选构建指纹         | 8 个产物，aggregate `2b90a9a3d8039a13861dbc1e7178f7639a7619f19d963b553ed14e65596e9399`                                 |
| 最近默认结果           | check：Vitest 2075 通过/18 跳过，Node 174 通过，external-builds 6 通过；E2E：179 通过/22 跳过/0 失败/0 flaky，201 收集 |

本机封存回执为 `.local/refactor/address-input-fix-20261019T064230147345Z/`，其中 `final-state.json`、`final-receipt.json`、`models-final.json` 和 `integrity.json` 提供逐文件与角色证明。这是本地证据路径，不假定其他 checkout 或 CI 已持有。更早的 `address-input-fix-20261019T044711827671Z/` 与 `diagnosis-20261018T191532Z-Ppz8aQ/` 同样只读。

实施开始时重新核对 pwd、remote、HEAD、分支、完整 dirty/untracked 清单、实际工具链及既有 14 个候选文件指纹。本计划加入后，完整源码指纹会变化，应冻结新的实际输入，不把上表指纹硬套到新目录。发现其他改动先保留并说明，不 reset、stash、clean 或回退到 HEAD，也不使用主工作树源码。

本包新证据使用 `.local/refactor/r5-export-contract-<唯一UTC时间戳>/`。记录源码、测试、构建、依赖、环境、命令/时间/退出码和 raw logs；旧失败及旧证据不得覆盖。独立副本必须包含未提交候选，不能只检出 HEAD 就称为当前基线。

## 3. 已核对的当前实现

以下是本树静态检查事实，不是本计划已经执行回归的声明。

| 落点                                                                       | 当前事实与本包含义                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [managed-app.ts](../../packages/protocol/src/managed-app.ts)               | `EDU_SOURCE_BYTES=524288`；`AppSourceSchema` 限制 1–256 文件和单字段长度，尚无解码后总字节约束；其 profile 使用包含 Mota 的通用 `AppProfileSchema`。导出上下文需要明确合同，但不能从通用 AppProfile 删除 Mota。 |
| [app-service.ts](../../apps/service/src/app-service.ts)                    | `validateAppSources` 已检查 256 文件、合法 base64、解码后 524288 字节，错误/注释却称“传输预算”；该函数还被 create/import 等路径复用。`export()` 已拒绝 Mota，选用登记的 profile，并在 helper 返回后再验证。     |
| [app-helper.py](../../apps/service/src/app-helper.py)                      | `LIMIT=8*1024*1024` 同时用于标准 create 和标准 export；标准 export 读取 `LIMIT+1`，edu export 经既有 edu 校验使用 524288。不能全局替换 LIMIT，也不能据 helper 的 8 MiB 宣称端到端已支持 8 MiB。                 |
| [source-export.ts](../../apps/desktop/src/main/workbench/source-export.ts) | 两类导出共用 `EDU_SOURCE_BYTES` 名称；预算、编码、散列等验证在创建输出前完成。其 edu 分支之外目前按标准布局处理，应明确拒绝不支持的导出 profile。                                                               |
| [chat-service.ts](../../apps/desktop/src/main/chat-service.ts)             | `app.export` 与 `app.taskSource` 都解析 `AppSourceSchema`；收紧共享 schema 必须检查 edu 任务取源兼容性。                                                                                                        |
| [chat.ts](../../packages/protocol/src/chat.ts)                             | `app.export`/`app.taskSource` 请求只允许严格的 AppTarget，回复使用包含 AppSource 的联合类型；不能增加 renderer 可设置的预算字段。                                                                               |
| [host.ts](../../apps/desktop/src/main/workbench/host.ts)                   | `appExport` 经 ChatService 取得来源，再调用 Main 的 `exportAppSource` 落盘。无需新增 IPC、Preload 能力或第二套编排。                                                                                            |

当前有效边界已在 service/Main 收紧为 512 KiB。主要修复是让标准 helper 的读取/返回限制提前一致，以及统一明确的导出预算及其校验依据；不能把已有拒绝称为新功能。

另一个须保留的事实：service 中 GuestStart 的 1 MiB 说明是调用侧注释，helper 输出在 launch 中还有 `12*1024*1024` 的字符串日志窗口。实施前须核对真实传输校验点和计量单位，不能把注释、字符串长度、源码字节与帧字节当作同一个预算。

## 4. 冻结的行为合同

| Profile           |          导出文件数 | 解码后源码总字节 | 导出能力                                 |
| ----------------- | ------------------: | ---------------: | ---------------------------------------- |
| standard-app v1   |               1–256 |          ≤524288 | 保留                                     |
| edu-web v1        | 1–256，包含必需文件 |          ≤524288 | 保留现有允许路径、导入基线及保护文件校验 |
| mota-web v1       |              不适用 |           不适用 | 保持 unsupported                         |
| 未知 kind/version |              不适用 |           不适用 | 明确拒绝，不回退到标准预算               |

必须保持以下约定：

1. 无 profile 的合法旧标准来源继续按既有 standard-app 兼容语义处理，不据缺字段推导 edu/Mota。
2. 字节数按各文件实际解码后的 bytes 求和；不是 JavaScript 字符数、base64 长度或序列化 JSON 长度。单文件可以为空，文件集合仍须满足现有最小数量。
3. 文件数/字节数的 limit 恰好允许，limit+1 拒绝；禁止截断文件、丢弃超额文件或只返回前缀后报告成功。
4. 导出预算由可信 service 根据登记 profile 选择，helper 接收的内部预算须校验类型、支持范围及与 profile 的一致性。缺失、伪造或放大的导出预算不得默默降级/放行。该内部字段不是 renderer、页面或模型可指定的公共参数。
5. Main 对收到的导出再次做完整校验；预算/格式/profile 拒绝须发生在创建该次输出之前。已有输出和来源文件不变，不产生半份“成功导出”。
6. 标准导出保留现有布局和 `sha256(JSON.stringify(files))` 传输散列；edu 保留 `source/ + manifest.json`、实际文件元数据散列及不可变 importBase。不借此统一不同 sha256 字段的含义或迁移格式。
7. 源码、创建/执行副本、依赖包、base64 字段、请求/响应传输上限分别记账。保持原源码合同；若现有有限帧无法承载合法上限输入，先给出可复核的长度推导和最坏合法夹具，再决定最小的导出专用调整。不得直接放宽全局通道或改成无上限。
8. edu 的后端、锁文件、允许编辑范围及基线复核保持现有语义。标准/edu 既有路径、重复项、链接和文件目录冲突等负例继续有效；本包不承诺新增 OS 隔离或重写所有路径策略。

## 5. 最小实现及可写边界

按“协议定义 → service 可信选择 → helper 受限读取 → Main 完整落盘校验”串行处理。

| 文件/区域                                          | 允许变更                                                                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol/src/managed-app.ts`             | 明确命名的导出 profile/预算表及纯校验；检查合法 base64 对应的解码长度。保持公共字段形状、旧标准兼容与通用 AppProfile 能力。不得引入 Node API。       |
| `apps/service/src/app-service.ts`                  | 导入预算定义、导出结果校验、仅在 `operation=export` 时构造可信 helper 预算。共享 `validateAppSources` 的现有 create/import/apply/task 语义必须保留。 |
| `apps/service/src/app-helper.py`                   | 仅导出预算验证和 standard/edu 导出读取路径；使用有界读取并检测额外字节，不能截断为成功。保留 create、依赖、启动、恢复、取消和执行副本的独立预算。    |
| `apps/desktop/src/main/workbench/source-export.ts` | 从明确的导出合同取预算，拒绝不支持的 profile，全部预算校验先于输出创建。保留布局、散列、权限及返回契约。                                             |
| 对应现有测试                                       | 优先扩展 `edu-app.test.ts`、`app-service.test.ts`、`edu-helper.test.ts`、`source-export.test.ts`；保留已有断言与预算。                               |
| 关联接线（有必要才改）                             | `packages/protocol/src/chat.ts`、`apps/desktop/src/main/chat-service.ts` 及其测试：仅用于导出上下文校验接线，不增加公共预算参数。                    |
| E2E（有必要才改）                                  | `e2e/workshop-actions.spec.ts`、`e2e/fixtures/sbx-app-actions.mjs`：只补导出 UI/失败发布回归，不能把 fixture 的模拟 helper 结果当真实 Python 检验。  |

不预建通用预算框架、目录或第二模板。优先复用现有测试宿主；仅在确无合适位置时新增一个针对实际 helper 的测试文件，并说明必要性。

下列区域只读：原 7 候选及地址修复 7 文件、所有已封存证据；`AppService` 的 start/stop/cancel/exitCompletion/cleanup/persist 状态链；guest-helper/owned-process/Python 隔离；edu-source、mota-source collectors；Mota server/save、R4 模型门禁；renderer、Preload 权限、布局和地址框。

尤其不能通过修改公用 `LIMIT`、`EDU_SOURCE_BYTES` 或公用 schema 顺手改变导入、执行副本、Mota 资产和任务取源合同。`AppSourceSchema` 当前消费者已列出；实施前确认是直接收敛该共享 schema，还是以窄导出校验接线。两者都必须通过现有 `app.taskSource`/edu 任务回归，不能删分支换取通过。

## 6. 验收矩阵与反例

所有预算负例须先满足身份、路径、编码、profile、散列及必需文件等其他前置条件，确保失败来自被测预算。改动 payload 后重新计算合法的传输散列；断言具体预算/unsupported 原因，不能只断言任意抛错。

按层职责覆盖矩阵，避免把所有组合重复成多套大型集成测试。helper 超限反例只需 524289 字节的小型临时工程；Mota 拒绝使用最小合法 profile，不引入大型资产或增加 Python 并发压测。

| 验收项                 | 夹具与预期                                                                                                                                             | 主要证明层                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| 标准 helper 现有不一致 | 先创建合法的小型临时项目，再让可导出文件实际增长至 524289 字节；同一回归要求 helper 不输出成功来源。旧 helper 应暴露接受超额源码的问题，保留真实失败。 | 实际 Python helper，非 service mock |
| 文件数边界             | 两种支持 profile 分别 255/256/257 个真实可导出文件；前两者通过，后者拒绝。edu 计入必需文件。                                                           | protocol/service/helper/Main        |
| 字节边界               | 两种 profile 分别 524287/524288/524289 解码 bytes，测试单文件和多文件合计；其他 edu 文件占用也计入总量。                                               | 四层                                |
| 编码膨胀               | 中文/emoji 内容、合法多字节路径、不同 base64 padding；source 内合法输入不因将 base64/字符数当源码 bytes 被误拒。记录真实请求、helper 结果及回复尺寸。  | 纯协议、实际 helper、service        |
| 非法输入与权限         | 无效 base64、未知 profile/version、伪造或放大/缺失 helper 预算；renderer/RPC 额外预算字段拒绝，service 预算取自已登记 profile。                        | 协议请求边界和可信组装              |
| Mota 不新增导出        | 最小合法 Mota profile 在导出上下文拒绝；service 不启动导出 helper，Main 不创建输出。Mota 导入/启动描述的协议仍合法。                                   | 服务调用计数、协议、落盘            |
| 完整发布               | 成功导出所有文件与散列/布局相符；超额失败后输出父目录没有该次新结果/有效 manifest，已有结果和源文件原字节保留。                                        | Main 临时目录实际读写               |
| 共享路径不回归         | 旧标准无 profile、edu 保护文件与 importBase、任务取源及已知 busy/停止/关闭语义维持。保留现有路径/链接负例。                                            | 现有协议/service/Main 测试          |
| 实际调用链             | 原 Workshop 创建/导出/恢复 E2E 继续通过；有新增失败场景时，消息可见且没有成功导出路径或半份有效结果。                                                  | 默认 Electron，fixture 边界注明     |

首次只读核验若发现预期旧行为不成立，先检查工具链、夹具和真实代码路径，报告事实并修订原因；不能制造失败后再宣称修复。定义回归后冻结同一测试，在修改前后分别运行；产品变化与测试修正分开保留，不能只证明 mock 的预算常量相同。

## 7. 实施与验证次序

1. **冻结输入。** 读取最新回执，核对工作树/工具链、原 14 文件和封存证据；建立本包新目录、命令记录器及必要对照副本。确认当前 profile/校验函数消费者和 transport 的真实边界。
2. **固定预算及测试。** 先补实际 helper 的标准导出超限反例和边界矩阵，保留修改前结果。无需再复制整套旧诊断框架。
3. **最小实现。** 同一文件一个写入者，按第 5 节次序完成；Main/service 现有状态归属和 Promise 清理次序不变。
4. **定向验证。** 同一回归在修复后通过，核对真实 source bytes、返回数据及输出目录，不增加超时、重试或全局降低并发。
5. **关联回归与完整 gate。** 在最终固定候选串行执行类型/静态/单测全链、必要的基线自检、实际新构建与默认 E2E；不能把 pnpm check 被截断的后续阶段记为通过。
6. **独立审查和修正。** 审查预算权威、跨层一致性、共享消费者、拒绝副作用、原断言及旧证据；必要修改后重新绑定相应验证。只有证据/文档修正时，不伪造或补填历史现场。
7. **交付并停止。** 输出完整补丁、逐文件指纹、真实命令及原日志、前后行为、模型参数、审查/处理、历史问题及未运行项。本包后不自动实施 R6 或其他包。

计划中的定向入口（实际执行需在固定工具链和新回执下进行）：

```sh
pnpm exec vitest run packages/protocol/src/edu-app.test.ts packages/protocol/src/mota-app.test.ts apps/service/src/edu-helper.test.ts apps/service/src/app-service.test.ts apps/desktop/src/main/workbench/source-export.test.ts apps/desktop/src/main/workbench/managed-app.test.ts apps/desktop/src/main/workbench/managed-app-host.test.ts apps/desktop/src/main/chat-service.test.ts
pnpm check
pnpm baseline:selftest
pnpm build
node scripts/run-e2e.mjs e2e/workshop-actions.spec.ts --grep 'Workshop App dialog creates, exports'
pnpm test:e2e
```

定向列表不是要求每次编辑都跑整组；首次固定相关集合，最终在同一候选完成集合与全量 gate。若修改协议共享校验，按实际消费者补相应的协议/edu-task 现有测试，记录新增清单，不能借此遗漏原用例。默认 E2E 当前参考为 201 项；有新增用例时明确逐项增量并核对原 201 项无遗漏。上轮绿色是参考，不替代 R5 新候选验证。

## 8. 工具链、桌面与证据要求

复用已核验的 portable Node 24.21.0、pnpm 10.34.6、Python 3.9.6，CI=true、TSESTREE_SINGLE_RUN 未设置。实际路径从上述工具链回执读取并打印版本，不静默使用全局 Node/Python。依赖先验证与锁/准备回执匹配；缺失或漂移时才按仓库显式准备流程处理并保留前后指纹，不自动更新锁。

构建、测试和共享环境操作串行。窗口轮开始前取得当轮用户确认并观测桌面；较早的确认/探针不是永久有效。记录目标 Electron PID、窗口/WC、前台、原生焦点与 DOM 焦点；缺失字段写 unknown。IOConsoleLocked=false、DOM hasFocus 或缺失 CG 不等于解锁。

每个窗口轮启动前检查明确锁屏信号，并及时查看执行中采样。出现 CG=true/loginwindow 等阻塞时停止启动后续窗口动作；若中断在途轮，保留日志并核实所属进程停止，未核实不得写成清理完成。锁屏或条件不明的通过不得代替解锁桌面验收。不得修改锁屏策略。

回执必须绑定本轮实际源码/构建与完整产物；命令的 requested、spawned、exitCode、not_run、failed 分开。阻断前未启动子命令时，不把记录器退出码写成子命令退出码。只有实际采集了前后清单，才能声明“输入未变化”；沿用脚本前清理或明确标注旧的固定元数据，不能让旧确认文字冒充本轮事实。

## 9. 分工、停止条件和完成定义

后续实施沿用会话模型要求：主控目标 gpt-6-astra，记录实际 Harness 声明及可核验证据；实施者与独立审查者分开，均通过真实工具 model 字段或 Codex CLI `--model gpt-6.1-sol` 选择。没有选择字段或模型不可用时如实报告，不静默替换；CLI 参数不等于后端运行时身份认证。

检索范围限定目标工作树及指定证据；不以其他 worktree 或本地 memory registry 作为输入。角色约束不等于 OS 隔离证明。每次委派给出可写文件/区域；主控核对实际 diff 和执行证据。计划准备本身不需要启动产品执行器。

遇到以下情形应保留现状、报告并重新确认设计/范围，不自行扩大：

- 必须改变 256 文件/524288 解码字节合同、启用 Mota 导出，或增加 renderer/页面可指定预算的公共参数。
- 必须改导入/创建/执行副本、通用传输、持久化格式、ID 规则、R3 生命周期、R4 门禁或 R6 保存授权，且无法证明是本包既有语义的最小接线。
- 必须覆盖原 14 文件或旧证据、改固定验收、删弱断言、提高默认预算/重试或降低全局并发。
- 发现共享 schema 会破坏合法的 app.taskSource/edu 任务输入，或真实现状不支持计划里的反例归因。
- 工具链、输入指纹、必要权限或桌面前提不符；缺少真实模型参数或独立角色。

四项历史单测若重现，保留退出码、阶段、资源信息和原日志；判断是否有本包新增回归证据。未能归因则单列，不自动处理其根因。默认全量受既有问题阻塞时，写明“R5 局部合同修复已验证／整体验收 incomplete”，不通过绿色复跑改写旧失败。

完成要求是：同一合同在四层成立、前后反例有效、正常/边界/拒绝路径具备真实证据、共享语义未回归、最终 gate 和独立审查结算清楚。真实模型、guest live、物理音频、packaged、远端 CI、R6/S4 及提交/推送/合并/发布/部署均不由本计划自动授权。
