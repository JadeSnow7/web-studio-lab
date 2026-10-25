# Workflow / Ultra 修订设计

2026-10-25 整合协调（本轮整合说明）：下文“未实现”“本计划尚未执行”与 `not_run` 记录的是 2026-10-24 初始设计审查，不是对后续源码的扫描结论。候选已有 WF-W0–WF-W8 源码和历史执行记录；源码存在及过去 fixture/窗口结果不能替代当前候选复验。Main 是业务、授权和持久提交权威；service 内唯一 kernel 负责冻结授权内的调用调度、有限重试、有序交付与 VM 推进，事件经 Main Journal 确认。原“调度决定在 Main/service 仅 VM/CLI”的放置表述据此细化，不能据旧文档再建另一套执行状态机。

Workflow 的实际隔离适配器仅 Codex native；已取得的历史真实运行证据仅覆盖 `codex:default`，当前候选未做真实多 Profile 矩阵验收；成员表由 Main 每次受理时冻结的 Profile 快照生成。离线 MockHarness 多成员矩阵不是真实矩阵。WF-W8 已完成本轮聚焦修复和离线复验，最终构建与窗口验收待主代理执行，E8、WF-W9/Ultra 未做，不能据历史记录接受 P2/P3。多 Harness 路线中的 MHC-W8 Bot/会议、MHC-W9 Gemini/Cursor 与本文 WF-W8 固定波次、WF-W9 Ultra 不同；见 [ADR-0003 协调附录](../../architecture/adr/0003-pluggable-harness-and-collaboration.md)。

推荐以“确定性只读执行 → 隔离候选写入 → 并行 Lane → Ultra 策略”推进。核心不依赖指挥 Harness，但复用 Lab 当前的身份、权限、执行适配与验收边界；不在 Rein 建第二个编排器。

本文为 2026-10-24 候选合同，问题依据见[审查记录](README.md)，实施顺序见[计划](plan.md)。当前架构的单 Agent 范围仍有效；未来实施首个产品入口时，应明确扩展范围并同步架构文档，不能把本方案当成已实现说明。

## 1. 责任、身份和范围

Main 中的 WorkflowApplication 拥有 workflow 状态、授权、Journal 和调度决定；它属于“任务与执行”职责，不是第二个产品业务核心。WorkbenchApplication 继续拥有 TaskVersion、TaskRun、项目写许可与人工接受。两者只通过窄用例交互。service 负责 VM/CLI 执行与进程事实，不自行推进另一份业务状态机；renderer 只读投影。

QuickJS 在 service 管理的独立 worker 中运行，避免同步脚本占用 Electron Main 或现有执行服务事件循环。worker 接受有界消息，不具有直接驱动 CLI、文件或网络的能力。Main 作派发授权；宿主适配器落实能力限制。仅线程隔离不被描述成 OS 文件权限隔离。

用 `workflowRunId` 标识一次 workflow，引用所属 `taskRunId`、固定任务版本、workspace/project 和初始输入快照。`callId` 标识逻辑调用；`callSeq` 是脚本发出调用的逻辑序号；`attemptId` 标识真正执行或重试；`eventSeq` 是进度事件序列；实际启动次序单独记录。不得把这些序号混成现有 TaskRun 的事件 seq。缓存命中有本轮调用记录，引用原执行和原轨迹，不伪造新的执行轨迹。

首轮限定本地受控沙箱、一个项目、一个明确授权根。IM 绑定、定时触发、webhook、远程分布式调度、点对点协商、实时用户阶段输入和自动部署不纳入 P0–P3。后续定时命令需独立合同，不以本方案提前获得后台执行权限。

## 2. 源格式与 API

采用标准 ES module：首条语句为纯 JSON 字面量 `export const meta`；其后只能声明一个 `export default async function main()`，脚本逻辑在 main 内。拒绝顶层副作用、其他 export、静态/动态 import；不为 Claude 的自定义顶层 return 格式增加兼容转换。AST 只解析，不执行 meta。

```js
export const meta = {
  name: 'diagnose-types',
  description: '在固定输入上汇总类型检查结果',
  phases: ['诊断', '汇总'],
};

export default async function main() {
  phase('诊断');
  const result = await agent('只读取固定快照中的诊断材料', {
    isolation: 'readonly',
    label: 'diagnose',
  });
  if (result.status !== 'ok') return { status: 'incomplete', callId: result.callId };
  phase('汇总');
  return { status: 'complete', diagnosis: result.value };
}
```

六个原语的名称保留，语义由 Lab 自己版本化：

| 原语                         | 修订语义                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `agent(prompt, opts)`        | 返回可判别的结果对象；成功值不携带隐式失败；默认 readonly，但只有底层已证明该能力才可派发                                             |
| `parallel(thunks)`           | 按输入顺序登记分支；按输入顺序收集结果；异常不隐藏；P1 只允许只读调用                                                                 |
| `pipeline(items, ...stages)` | 保留输入槽位；每阶段输入是上一阶段的成功值，失败/冲突槽位不继续后续阶段；受下节确定性交付约束，取消“任何元素完全不等待其他元素”的承诺 |
| `phase(title)`               | 只能在没有活动 fan-out 的主流程切换；标题须在 meta 中声明；调用登记时冻结阶段；分支通过 `opts.phase` 选已声明标题                     |
| `log(message)`               | 有界结构化日志；不作为权限、成功或验收事实                                                                                            |
| `args`                       | 进入 VM 前经过 JSON 边界校验的深只读输入；缺省为 null，哈希参与运行身份                                                               |

`AgentResult<T>` 为 `ok {value, callId}`、`failed {code, message, callId}`、`conflict {files, candidateRef, callId}` 的联合类型。失败不再一律压成 null；schema 合法的 null 可以是成功值。pipeline 直接传播失败/冲突槽位，parallel 不过滤；脚本必须显式处理。整个 workflow 停止或脚本违约由宿主终止，不返回可被 catch 后继续派发的普通 null。

opts 保留 harness/profile/model/tier/schema/isolation/label/phase/timeoutMs/retries/tools；model 与 tier 互斥。schema 在任何启动前校验，禁止外部 `$ref` 获取。tools 是申请的能力子集，不能扩大父任务权限；适配器不能映射或落实某能力时拒绝，不用提示词替代。结果统一解析、校验和修复策略由应用用例拥有，适配器的原生 schema 能力仅作优化。P0 不开放写模式，后续能力按阶段启用，未支持的值明确拒绝。

## 3. 确定性与并发

选择确定性的结果交付策略：宿主可并行执行已登记调用，但 VM 只按 `callSeq` 递增接收终态结果；每交付一个结果，就按固定规则推进 jobs 至本轮可运行队列耗尽，再交付下一个。命中缓存也进入同一缓冲队列，不能立即 resolve。callSeq 在脚本调用 agent 时分配，不在 CLI 真正启动时分配。

这会产生队首等待，是保证任意脚本闭包、中间变量和条件分支可重放的明确代价。只增加结构化节点 ID 不能消除共享变量的竞态；本版不采用“谁先完成谁推进”。所有等待都有不可被重试/换账号重置的总 deadline。实际进程启动次序、时长与 token 消耗可以不同，不属于 E1 的相等对象。

确定性保证的前提是：相同 DSL/VM 版本、脚本/args、冻结输入、有效执行语义，以及每个逻辑调用的相同终态结果，包括失败类别。时间、随机外部结果或超时改变终态时，不承诺走相同分支。脚本不可读取宿主时间、物理完成顺序或调度统计。

P0 顺序执行；P1 先证明只读并发。P2 写调用只允许串行主流程。P3 只增加固定波次的并行 Lane：波次进入时冻结共同基线，登记全部候选，按逻辑序号发布；下一波依赖已发布结果。不开放任意嵌套、读写混合的自由流水线，避免未定义的快照与合并依赖。

每个 call 默认使用全新 Harness 会话，不能共享指挥或其他节点 thread。相同输入的多个独立采样必须使用不同 label/序号；不会在同一运行里把两次采样合成一次。阶段中禁止由回调启动不可追踪的后台调用；main 返回时仍有未归并调用视为脚本错误，进入清理，不能提前宣告完成。

## 4. 沙箱与资源

首选 quickjs-emscripten 普通构建，通过 `newPromise` 暴露 agent，通过受控 `executePendingJobs` 交付结果。不使用 Asyncify 挂起作为并发机制；这是待 P0a PoC 验证的选型。依赖与 WASM 版本在 PoC 后固定并纳入运行身份。

VM 不注入文件、网络、进程、计时器、模块加载和动态编译能力。禁用整个 Date、Math.random、eval、Function 及相关构造器入口，避免只拦 `Date.now()` 而漏掉 `Date()`、别名或构造器。不得暴露宿主对象/prototype；JSON 按数据传递，宿主避免把外部键合并到带原型对象。AST 用于可读的提前报错，实际能力边界在 VM 和宿主桥接。

保留 64 MiB VM 堆、2 秒单次同步计算作为实验初值，另外固定累计脚本执行预算、jobs 数、日志总量、prompt/schema/args/result 单体大小、桥接缓冲总量、pending 调用数和整轮 deadline。计算预算只计进入 VM 的执行片段，等待 CLI 不计 CPU；wall deadline 单独记录。微任务链必须消耗同一累计预算。资源初值在 P0a 冻结，不用未测的 16 并发作产品默认值。

超过 1 MiB 的最终结果可发布受控 artifact 引用，但在序列化、传输和落盘前后都要有上限；不能先无界 dump 再检查。结果引用含摘要/hash/大小和权限归属，不把宿主任意绝对路径当授权。超限、协议破坏和脚本错误取消所有子调用，保留已产生候选，等待进程清理。

## 5. 冻结输入与缓存

InputSnapshot 覆盖项目身份、实际源码（含参与任务的 dirty/untracked 文件）、依赖锁文件和安装环境标识、固定工具配置、可用资料版本、能力策略以及明确的数据 fixture。凭据不入快照；生成目录、缓存和临时数据按声明排除。Git tree 可作内部索引，不能单独代表完整输入。

readonly 在不可变输入和每次调用独立 scratch 上运行；不得写主项目、公共 Git 管理目录或其他调用的 scratch。测试生成物只写本次 scratch。底层能力不能实现时该 Harness 的 readonly 标为 unavailable。只读网络访问、活动数据库、dev server 状态等不能被冻结时，默认不复用该调用；“没有写代码”不等于纯函数。

路由先解析有效执行语义，再计算键。键包含规范化 prompt、实际 Harness/模型/推理档位、适配器/模板与策略版本、schema、isolation、label、tools、输入身份。自动 Profile 可以不进入语义键的前提是已经验证同等执行能力与数据可见性；否则必须分区。显式 Profile 总是进入键。记录实际 Profile 出处，但不存凭据。

P0/P1 只在同一授权范围和 resume 祖先链查缓存，不建跨项目全局缓存。只复用持久化成功、对象完整、输入与能力仍适用的结果；cached 记录继续追溯原成功记录。失败、停止、待核对、对象丢失/损坏不命中。策略变更时不能仅凭旧 contentKey 命中。

精确续跑保留原 scriptHash、argsHash、输入与 DSL 版本；编辑脚本/args、切换有效 Harness/model 或变更项目输入创建新派生运行，保留 lineage，重新授权，首版不复用写前缀。P2 的写缓存只复用同一续跑链中已经发布的确定前缀，read-only 按完整输入判断。失效后不得直接在历史末态工作区重复执行。

## 6. Journal、写入与恢复

Journal 是 workflow 调用、attempt 与事件的权威记录；既有 TaskRun 只保存关联和对外投影，不复制一份 workflow 可独立修改的状态。SQLite 由 Main 应用用例单写，schema 带版本，未知新版本保留并拒绝；产品已有 JSON 历史不在本工作包迁移。

至少区分 run、call、attempt、event、result artifact、snapshot 与 publication。call 记录逻辑身份、输入/有效执行语义、原始成功来源、结果与轨迹引用；attempt 记录每次启动、PID/进程归属、实际 Profile、退出与清理事实。不要仅用 `(run_id, seq)` 一行覆盖重试历史。usage 未提供时为 unknown，不能记 0；缓存记录分别显示本轮消耗与历史消耗，避免重复累计。

写模式采用以下语义：

| 模式     | 执行位置与发布                                                   | 自动恢复                                                                |
| -------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| readonly | 不可变输入 + 独立 scratch，不发布项目修改                        | 已提交成功结果可复用；未完成调用可重跑                                  |
| lane     | 从固定输入建立独立 attempt 候选，成功后发布到 run 的受管候选快照 | 失败 attempt 保留诊断，重试从同一输入重建；已发布效果必须与结果共同恢复 |
| shared   | 在明确授权的受管可变实例中操作，持原所有者的写许可               | 无法证明副作用状态时待核对；不自动重放。首版 P0–P2 不开放               |

阶段 A 即使写调用串行，也不能把 lane 变成直接修改用户 checkout。内置 Git commit/ref 只属于 Lab 管理的候选存储，不改用户 HEAD/index、不覆盖 dirty 文件、不触发用户 hooks 或推送。首版优先使用独立物化目录；后续 git worktree 仅作性能实现，必须额外隔离其共享 Git 元数据。

发布协议：先持久化调用意图与 attempt；CLI 只改本次候选；校验结果与候选后写不可变、可校验的结果和快照对象，并确保落盘；最后在 SQLite 事务中同时登记成功结果、publication 和当前候选快照指针。指针使用预期旧快照作条件更新，冲突不覆盖。未被事务引用的对象是孤立候选，不能推断已发布；事务成功后才能向 VM 交付 ok。产品工程的最终应用须由项目状态所有者新增带版本条件与授权的窄用例；当前仓库没有可直接复用的候选应用 API，接入前此操作为 unavailable。最终应用不是 Journal 成功的附带动作；它还须检查外部修改并保留冲突，不承诺锁住所有外部编辑器。

恢复先核对并停止旧执行进程，确认没有并存写者；在新的受管候选里从初始快照重建逻辑前缀。命中写节点时校验并推进到其 snapshotAfter，再交付保存结果；不再次运行 CLI，也不在用户当前目录做 reset。结果已提交但 VM 未收到可以安全重交；候选已写但未提交只重建未提交 attempt；shared/外部非幂等副作用无法确认时进入 `needs_reconciliation`，保留现场。

E3 的保证限定为已持久提交的结果/效果不重复执行，最终受管候选一致。不能承诺 CLI 已花 token 但未提交的调用永不重跑，也不能对外网/数据库任意副作用承诺 exactly-once。自动重试只适用于已证明隔离或幂等的操作。

P3 合并使用固定共同基线与固定发布顺序。无冲突生成新受管快照；冲突返回独立 conflict 结果并保留候选，不自动启动合并 Agent。合并 Agent 只有脚本显式请求且获授权才可运行。agent 的 ok 必须在发布完成后交付；不能把“候选已生成”伪装为“已合并”。

## 7. 生命周期、调度与预算

运行区分 `running / pausing / paused / stopping / stopped / completed / failed / needs_reconciliation`。暂停先关闭派发入口，运行中调用可完成并落盘；结果暂存，不继续推进 VM；所有在途调用终结后才 paused。恢复暂停继续同一运行；终止后续跑建立新的 workflowRunId。停止先关闭全部新动作入口，再取消所属执行并确认清理；确认前不能标 stopped、释放写许可或发起续跑。退出应用执行同样的清理，重启不自动恢复 CLI。

调度同时约束总并发、实际执行位置的资源、Profile 容量、项目/候选写许可和预算。host 内存不能替代远程 guest 内存事实；无法可靠读取额度时显示 unknown，不能声称“选择余额最多”。P0 并发 1；P1 实测小并发后再提升。当前 Profile 单活动执行约束保留，扩展前必须有独立验证。

429 可以不消耗业务 retries，但必须消耗统一 attempt/时间/成本预算；禁止无限换账号。持有写许可或并发槽时不等待令牌回填。排队从原请求创建时计时，换 Profile 不重置 deadline；永久限流、内存长期不足或无可用账号必须在截止后明确失败。首次派发前可从用户事先授权的集合解析路由，解析后冻结该 call 的 Harness/model/推理档位；重试和精确续跑不得自动跨这些执行语义切换。只有已经验证等价且获授权的自动 Profile 可替换，显式 Profile 固定。用户要求切换 Harness/model 时按第 5 节创建派生运行，不掩盖前次失败。

保留每次 parallel/pipeline 4,096 项与每轮 1,000 个逻辑调用的硬上限；另有所有重试共用的 attempt、token/成本与时间预算。缓存命中也计入逻辑调用上限。实际 token 不可知时依据硬次数/时间限制并标记 unknown；不得称为精确 token 截断。25 个调用、150 万预估 token 只作初始规模提示，Ultra 不豁免任何硬预算。

提示词前缀错峰先不上 P0/P1。只有在某适配器能证明 cache scope、实际模型/effort、system/tools/schema/cwd 等前缀一致时才实验；不能因“同一提供商”就假定跨账号共享缓存。错峰时间单独计入排队指标，不为节省 token 破坏期限。

## 8. 授权、MCP 与 Ultra

origin 由可信输入适配器写入，不接受脚本或工具载荷自报 human。根 workflow 必须关联真实人类请求和授权上下文；模型生成脚本只是该授权下的候选。上游数据可影响计算结果，不能自动扩大项目、工具、预算或目标。分隔提示可帮助模型辨认数据，不能代替宿主检查。

运行授权绑定脚本/args hash、任务版本、项目/输入、有效隔离方式、能力集合、路由范围和预算。保存命令的长期允许也绑定版本和权限，内容改变即失效；路径规范化、符号链接、读取与执行间变更都在边界检查。AST 阶段和数量只作审批展示；每次 agent 派发都执行动态能力与预算核对。

第一版只允许无交互子任务：需要额外工具审批时明确失败/要求拆分后重启，不自动批准或无限悬挂。现有 ACP 的人工请求机制仍保持原行为，新 workflow adapter 必须能辨认该状态并安全终结。停止/取消是生命周期控制，不视为脚本输入。

MCP 语义采用 `run/status/control/list_commands`，具体工具名遵守所用 SDK；run 以 requestId 幂等受理，立即返回 workflowRunId 与受控脚本 artifact。同 requestId 不同内容拒绝。Main 的状态查询为权威；异步完成通知携带事件身份和 `origin=agent_output`，可去重补读，不自动触发新根 workflow。child worker 不获得递归启动 workflow 的能力。

Ultra 在 P3 才启用：按实际 Harness 能力选择推理档位，附加“先判断是否值得编排”的指挥提示。默认关闭，不用关键词本身授予权限。跳过审批仅限已授权、版本匹配且在预算内的只读命令；任何 lane/shared 写入都需已有明确写授权，不能用 lane 标签绕过。默认沿用用户选定的指挥与路由；Claude 指挥/GPT 执行可作为用户配置示例，不硬编码。

## 9. 进度与验收

进度列表、阶段和节点详情从同一 Journal 投影。最小界面包含实际状态、phase、调用/attempt、缓存来源、usage known/unknown、耗时、停止与续跑；P0 不做完整三层仪表盘。恢复先查快照，再按 eventSeq 补事件，不用 renderer 事件数量推断终态。

每个实际 attempt 关联轨迹；cached 调用明确指向历史轨迹。视觉录制只有相关适配器已实现并采集时才显示，不保证所有 CLI 节点天然具有录像。末阶段模型结果是评估意见；独立检查器仍负责 passed/failed/undetermined；人工接受仍须通过既有 passed/current 门槛。

验收适用性绑定代码、任务、规则和运行条件。Harness 出处本身不是自动作废理由，但切换导致模型输出、工具行为或环境变化时要重新核对适用性，不能笼统承诺“切换 Harness 永不影响验收”。
