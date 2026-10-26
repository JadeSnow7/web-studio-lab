# W9 分批记录：推理档路由与 Ultra 标记

> 2026-10-25 分批整理：本记录依据原 dirty 快照到 observation-01/03 的 W9 20 文件增量。W8 cleanup/进程所有权/Profile 占用/回执优先级和已修复的崩溃恢复 E2E 保留。这里的 Ultra 是默认关闭、零特权的标记与参数接线，不是已接受的自主指挥能力；Harness #18/#22/#23 的继承审查阻塞未修复。

## 交付面

- **推理档路由（service）**：`NativeHarnessAdapter.argvForIsolation(isolation, execution?)` 增加可选 `execution: {model?, tier?}` 形参；返回 `null` 仍表示该组合表达不出。codex adapter 把 `tier` 映射为 `-c model_reasoning_effort=low|medium|high`（small→low、medium→medium、big→high），`model` 经 `-m` 原样透传（≤64 chars 已由 `validateOpts` 定界）；两者同帧组合，无 `execution` 时 argv 与既有版本逐位一致。此前 tier/model 只冻结进 `effective`/`contentKey` 不路由 argv，是假旋钮；本轮接通。
- **早拒绝（kernel + adapters）**：`WorkflowCallAdapter` 新增可选 `checkExecution(request): RouteRejection | null`。内核 `registerCall` 在 `resolveRoute` 之后调用——argv 组不出的 isolation+model/tier 组合按 `unsupported_option` 在 `attempt_start` 之前失败（与校验/路由拒绝同路径：call_start/call_end 照写、不派发 attempt）。`IsolatedGuestAdapter.checkExecution` 委托 `argvForIsolation` 表达力判定；`RoutedAdapterPool.checkExecution` 按已解析 `{harness,profile}` 委托到成员适配器，成员未命中或未实现放行。`IsolatedGuestAdapter.run()` 入口的 argv null → `unsupported_option` 判定保留为兜底（不 spawn）。
- **contentKey**：tier/model 继续冻结进 `effective` → `contentKey`（新增单测钉死）——续跑换档不命中缓存，是安全方向。
- **Ultra 开关（analyze → journal → renderer）**：`meta.ultra` 只收布尔字面量，非布尔/非字面量在 analyze 以 `script_rejected` 拒绝（fail-closed；`literalValue` 已保证字面量级）。`meta.ultra === true` 时内核把它回显进 `run` journal 事件；Main journal **schema v5** 给 `runs` 加 `ultra INTEGER NOT NULL DEFAULT 0`（v4→v5 `ALTER TABLE`，同 v4 手法），`appendEvent` 的 run 分支按 `CASE WHEN` 投影；`WorkflowRunRow.ultra` → `workflowRunRowView` → `WorkflowRunRowSchema` → renderer 在 run 行与详情显示「Ultra」徽标，无其他特权。
- **协议**：`ULTRA_DIRECTOR_HINT` canonical 中文文案导出（「先判断是否值得编排，不值得退化为单 Agent；值得才生成确定性 workflow 计划，规划/重试/停止/恢复全计预算」），供未来指挥侧/文档引用，**当前不注入任何会话**。

## Ultra 语义（默认关、零特权）

- `meta.ultra` 只是 run 的受理/展示/实验分组标记：**不跳过审批**（saved 命令批准绑定照常——E7-134/135 语料钉死）、**不改变预算**（attempt/时限/成本口径不变）、**不改变路由**（routeScope/Profile 成员表不变）。
- Main 不重新推导 ultra：`runs.ultra` 的权威值来自 service 内核的 run 事件回显（同一 `meta` 对象，单一来源），避免与 analyze 字面量判定双份实现漂移。

## E9 / E8 排除边界

本批不包含 `fixtures/workflow/e9/`、`scripts/e9-report.mjs`、E8 runner 或 live-probe。E9 已发现缺少预注册任务覆盖与 pair 唯一性校验：仅一个 task、重复同一 pair 的三条记录也可能得到 sufficient / meets_gate。该门槛缺陷未修复，E9 暂停，不能作为 Ultra 验收或默认启用依据。原始实验与 live 陈述仅在本地来源归档保留，不是本批执行结果。

## 裁量点

- **早拒绝选登记期**：`checkExecution` 插在 `resolveRoute` 之后（需要已解析 profile 才能定位成员适配器）；拒绝与校验失败同路径，不产生 attempt_start。比 validateOpts 阶段更晚半步但已能拿到成员身份，比 run() 入口早（不消耗注定丢弃的 attempt）。
- **argv 组装在适配器而非池**：`RoutedAdapterPool` 只做表达力委托，`call.effective` 原样传给成员 `IsolatedGuestAdapter` 组 argv——池不持有 native harness 引用，单一组装点。
- **codex 表达全集**：codex 的 model/tier 组合总能翻译为 CLI 开关，`argvForIsolation` 不会因 execution 返回 null；`checkExecution` 对 codex 恒放行，null 路径由 stub/未来 Harness 覆盖测试。
- **run 事件投影而非受理期 regex**：`runs.ultra` 由内核 run 事件回显写入（`CASE WHEN ? THEN ? ELSE ultra`），不新增 Main 侧 meta 解析；engine_rejected 的 run 行保持 ultra=0（无执行事实）。

## 验证范围与执行边界

- service workflow+harness 单测：codex argv 全组合、无 execution 不变、null→unsupported_option、checkExecution、contentKey 分区、analyze meta.ultra 布尔门禁、routed-pool 委托。
- Main：journal v5 迁移（v4 文件→v5 补列、旧行 ultra=0）、run 事件 ultra 投影、E7 语料增补 E7-126~135（越界/互斥/argv 不可表达/非布尔 ultra/批准不变）。
- E2E：`workflow.spec.ts` 新增 saved 命令 `ultra:true` + `tier:'big'` 用例。断言使用独立 sandbox 日志并绑定可见 run 行的完整 runId，防止其他运行的 high 参数使本用例误通过；本批只做类型及无窗口 fixture 断言验证，尚未运行该窗口用例。
- 上述是本批应覆盖的源码与用例范围；实际命令和结果绑定本批最终 tree，保存在仓库外报告。窗口 E2E、真实模型、guest 及付费调用均为 `not_run`，不把来源历史陈述写成本批通过。

