# Web Studio Lab Workflow / Ultra 方案审查与修订

> 分批提交说明（2026-10-25）：下文是原设计审查及冻结阶段的历史记录。原始方案附件、诊断脚本/回执和 E8 实验输入仅在本地归档保留，本次不公开；其相对路径用于本地追溯，不代表仓库已交付这些材料。当前源码整合、复验与仍未解决的审查问题见[整合记录](../../acceptance/consolidation-20261025/README.md)。

2026-10-25 整合协调（本轮整合说明）：下文“未实现”“本计划尚未执行”与 `not_run` 记录的是 2026-10-24 初始设计审查，不是对后续源码的扫描结论。候选已有 WF-W0–WF-W8 源码和历史执行记录；源码存在及过去 fixture/窗口结果不能替代当前候选复验。Main 是业务、授权和持久提交权威；service 内唯一 kernel 负责冻结授权内的调用调度、有限重试、有序交付与 VM 推进，事件经 Main Journal 确认。原“调度决定在 Main/service 仅 VM/CLI”的放置表述据此细化，不能据旧文档再建另一套执行状态机。

Workflow 的实际隔离适配器仅 Codex native；已取得的历史真实运行证据仅覆盖 `codex:default`，当前候选未做真实多 Profile 矩阵验收；成员表由 Main 每次受理时冻结的 Profile 快照生成。离线 MockHarness 多成员矩阵不是真实矩阵。WF-W8 已完成本轮聚焦修复和离线复验，最终构建与窗口验收待主代理执行，E8、WF-W9/Ultra 未做，不能据历史记录接受 P2/P3。多 Harness 路线中的 MHC-W8 Bot/会议、MHC-W9 Gemini/Cursor 与本文 WF-W8 固定波次、WF-W9 Ultra 不同；见 [ADR-0003 协调附录](../../architecture/adr/0003-pluggable-harness-and-collaboration.md)。

建议保留“指挥写脚本、Lab 执行、Harness 提供能力”的方向，先完成可恢复的只读闭环，再引入可发布的候选修改。原方案的异步顺序、写入重放、权限和阶段依赖尚不自洽，不能直接作为实现合同。

日期：2026-10-24（Asia/Shanghai）。本轮交付是设计修订与实施计划，未实现 workflow、未运行真实模型或 sandbox live。本文是新的候选设计，不改变当前产品已实现范围；实施时须同步更新受影响的架构合同。

- [修订后的设计](design.md)：推荐选择、接口语义、恢复与权限约束。
- [分阶段实施与实验计划](plan.md)：每个工作包的输入、写入范围、验收和停止点。
- 原始方案（本地保留：`original-proposal.txt`）：用户附件原样保留，作为审查来源。
- 诊断脚本（本地保留：`evidence/probe.mjs`）与原始结果（本地保留：`evidence/result.json`）：仅验证两个语言语义问题。

## 1. 审查基线

目标为本地来源工作树（机器路径未公开）；remote 为 `JadeSnow7/web-studio-lab`；HEAD 为 `fe3684f96c45e826af1071eb2058184c4aca4bf8`；分支为 `agent/simplify-ops`。读取时存在大量既有 dirty/untracked 内容，本轮只新增本目录，不将 HEAD 当作 dirty 源码的完整版本。源码定位仅代表本次静态读取，实施前必须重新核对。

已阅读根 AGENTS、README、CONTRIBUTING、架构基线、2026-10-06 历史基线和当前运行时相关入口。历史基线的“无应用源码”不适用于本树；当前多 Harness 配置也不等于 workflow 已落地。

## 2. 必须修正的设计问题

| 编号 | 原约定与最小反例                                                                                                            | 修订决定                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| R1   | pipeline 各元素自由推进，却要求启动 `seq → contentKey` 在随机延迟下完全相同；A/B 第一阶段反序完成就会交换第二阶段的启动顺序 | 区分逻辑调用序号与物理启动；采用确定性的结果交付顺序，接受队首等待，暂不承诺自由流水线吞吐 |
| R2   | W1 将计数 0→1、W2 将 1→2；从现有 S2 续跑，W1 的 S0 写键不命中，可能再次加一；从 S0 开始只返回缓存又会丢失效果               | 冻结初始快照，在受管候选中重建历史前缀；成功写节点的结果和已发布快照一起复用               |
| R3   | shared 已写文件，但 schema 无效、超时或 Journal 尚未落盘；自动重试会重复写                                                  | attempt 隔离、持久化发布协议；无法核对 shared 副作用时进入待核对，不自动重放               |
| R4   | 阶段 A 把 lane 直接降级为 shared，Ultra 审批却只拦 shared；阶段 B 并行读改写也不再等价于 A 的串行行为                       | 禁止静默降级；lane 始终产候选，shared 保留独立授权与恢复语义；并行写按固定波次另验         |
| R5   | worktree 可写且共享 Git 管理目录；tree hash 不包含全部依赖、数据库、网络与权限                                              | 冻结完整输入清单，底层限制写范围；不可冻结的外部状态默认不缓存                             |
| R6   | origin、AST 估算及“上游输出不是指令”被当成安全依据；不安全工具仍可能直接执行                                                | 宿主绑定授权根，审批绑定实际能力与脚本哈希，派发时再核对；E7 前移到首个执行入口            |
| R7   | `export const meta` 加顶层 `return` 不是标准模块；`T \| null` 不能表达合并冲突；全局 phase 在并发分支间串线                 | 使用标准模块与异步 main、显式结果联合类型、冻结阶段归属                                    |
| R8   | asyncify 不等于多挂起并发；2 秒同步段不能限制无限微任务、桥接输出或宿主阻塞                                                 | 首选 QuickJS 普通构建 + VM Promise + jobs pump，隔离执行线程，补齐总预算与迟到回调测试     |
| R9   | P0 仅只读，却推荐修复 tsc；P1 要全量写重放，隔离到 P2 才验；E7 到 P3 才进入门槛                                             | P0 只读诊断；隔离和恢复先于写能力；修复场景移到 P2；权限从 P0 开始                         |
| R10  | E9 同时改变编排、作者、模型与路由，不能分辨收益来源；3 次重复不足以证明普遍收益                                             | 拆成固定单 Harness、自动编排、多 Harness 三组增量对照；3 次只作先导                        |

R1 已用离线 Node 诊断复现：相同逐调用结果分别产生 `A1,B1,A2,B2` 与 `A1,B1,B2,A2`，最终按输入排序的数组相同。R7 的标准模块解析也已复现：原形式退出 1，异步 main 形式退出 0。其余结论是设计走查与源码/文档分析，尚无目标运行时实验证据。

## 3. 当前代码可以复用什么

| 当前入口                                                                                                                                                                   | 静态核对结果                                                   | 实施含义                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| [Harness types](../../../apps/service/src/harness/types.ts)，6–7、42–61 行                                                                                                 | 适配器只负责启动参数与事件解析                                 | 不另起第二套 CLI 驱动；workflow 用例位于其上层             |
| [Registry](../../../apps/service/src/harness/registry.ts)，9–12 行                                                                                                         | 注册 Codex native 与 Claude Code ACP                           | Gemini/Cursor/Devin/native 不能靠枚举声明为可用            |
| [CodexChat](../../../apps/service/src/codex-chat.ts)，397–450 行                                                                                                           | 一轮文本对话、会话槽与续轮 thread                              | worker 需独立执行身份，不能复用指挥会话槽                  |
| [GuestWriteLease](../../../apps/desktop/src/main/workbench/guest-write-lease.ts)，6–8、18–27 行；[ChatService](../../../apps/desktop/src/main/chat-service.ts)，498–523 行 | 所有轮次汇合到 guest 写许可，清理确认前不释放                  | 不同 Profile 也不能直接并发；不得通过删锁接入              |
| [Profiles](../../../apps/desktop/src/main/harness-profiles.ts)，213–216、258–299 行                                                                                        | 解析/准备 Profile；额度问题不自动切换                          | 新路由策略要显式定义、记录与授权，不能改成隐式 fallback    |
| [WorkbenchApplication](../../../apps/desktop/src/main/workbench/application.ts)，2407、2468–2474、2523–2545 行                                                             | 项目占用、Profile 活动检查、冻结执行来源、dispatch 前 baseline | 从所有者暴露窄用例；禁止新模块直接改内部 Map               |
| [Source repository](../../../apps/desktop/src/main/workbench/run-source-repository.ts)，241、255、355 行                                                                   | baseline、结束快照与 patch                                     | 可复用证据思路；当前 runId 数据不是任意 Git 工作区发布事务 |
| [Checker](../../../apps/desktop/src/main/workbench/checker.ts)，7、17–19 行                                                                                                | 产品检查器仍未接入                                             | 模型末阶段意见、离线实验通过都不能写成产品接受             |
| [ACP policy](../../../apps/service/src/harness/acp/policy.ts)，7–10、21–36 行                                                                                              | 工作区内写/执行等可自动 allow_once                             | Profile 不是只读安全边界，须另验底层能力                   |
| [Resource MCP](../../../apps/service/src/resource_mcp.py)，197–200、627–650 行                                                                                             | 已有运行内的资源/观察/操作入口                                 | 不能直接当外部 workflow 授权入口                           |

## 4. 外部依据与边界

2026-10-24 已在线核对 [Claude Code 官方 workflows 文档](https://code.claude.com/docs/en/workflows)：它支持脚本编排与续跑，但接口和重放行为随版本变化；16 是默认并发，当前文档允许配置更高值，不应称为不可变上限。Lab 的数值应以自身实验确定。官方使用示例不意味着 Lab 必须兼容其文件格式或内部实现。

[quickjs-emscripten 项目文档](https://github.com/justjake/quickjs-emscripten#promises)明确提供 VM Promise 与显式 jobs 推进；其 [Asyncify 说明](https://github.com/justjake/quickjs-emscripten#asyncify)限制同一个 WASM 模块同时挂起一次。基于这个约束，本方案选择普通构建加 Promise 桥接，仍需实际 PoC 验证。

[laiso 的原始观察](https://laiso.substack.com/p/handwriting-dynamic-workflows-in)可作机制探索资料，不能替代 Lab 的安全、协议和恢复合同；本轮未依据它对第三方内部实现作兼容承诺。

## 5. 本轮证据与交付边界

诊断由实现子代理在新临时目录编写，主线程已读脚本及输出。命令为 `node /private/tmp/wsl-workflow-review-20261024-probes/probe.mjs`，Node `v26.5.0`，退出 0；断言成功意味着反例被复现，不意味着原方案满足 E1。归档与临时原件逐字比较一致。

复跑时先把 `evidence/probe.mjs` 复制到新的临时目录，再在那里运行；脚本会在自身目录写 `result.json`，不要覆盖本次封存结果。Node 解析检查不是 QuickJS 解析/资源隔离验证。

文档检查、链接和最终审阅结果见[计划中的本轮检查记录](plan.md#本轮检查记录)。未运行产品类型检查、构建、全套单元/E2E、真实模型、sandbox live、E1–E9：本轮没有产品实现，两个诊断不能替代这些实验。全部交付保持本地未提交，原始 dirty 工作不在本轮验收范围。
