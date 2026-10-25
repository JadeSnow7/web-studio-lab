# W8 交付记录：固定波次并行 Lane

## 交付面

- **协议（`packages/protocol`）**：`call_end.status` 增 `'conflict'`，携带 `conflictFiles`/`candidateRef`；`attempt_start.laneBase` 记 lane attempt 的实际基线树；新增 `workflow-lanebase`/`workflow-lanebase.reply` 消息对（service→Main 取 lane 工作区）；`workflow-candidate.reply` 结果扩展为 `publication | conflict | ok:false` 联合；调用投影带 `conflictFiles`/`candidateRef`。
- **内核（`kernel.ts`）**：删除 `laneInFlight` 排他——lane 与 readonly 同享 `maxInFlight`（lane-vs-lane 并发即固定波次）。lane 终态先进 `pendingLaneEnds`，排干循环从最早未结束 lane seq 起逐个提交（cached 回放同走排干）；合并发布在提交时经 `publishCandidate` 端口完成——物理完成可乱序，发布必须按逻辑序号。`laneWorkspace` 端口在 lane 首次派发前取一次（重试复用），`baseTree` 写 `attempt_start.laneBase`，文件集经 `WorkflowCall.laneInput` 注入适配器。conflict 为终态不重试，交付 `{status:'conflict', files, candidateRef, callId}`。
- **analyze**：`isolation:'lane'` 字面量在恰好一层 `parallel()` 直接实参内合法；嵌套 parallel（depth≥2）、pipeline 内、parallel 内嵌 pipeline 一律以 `lane_not_serializable` 拒绝。
- **Main**：journal schema v4——`calls.base_tree`（call_start 时冻结 `runs.candidate_tree` 现值）与 `calls.conflict_json`；`RunSourceRepository.mergeCandidate` 文件级三向合并（ls-tree 平铺 diff + D/F 位置冲突判定 + 临时 index 构造合并树 M）；`publishCandidate` 改造为合并发布——冲突只登记 call 侧事实（候选留在 objects.git），无冲突事务内 CAS P→M 并写 publication（相同补丁 M==P 也写事实行）；`laneWorkspace` provider 物化调用登记基线下发工作区。
- **UI**：calls 表显示 `conflict` 状态、冲突文件清单与保留候选引用；conflict 不算 run 失败。
- **fixture/命令**：fixture sbx 的 collect 按 run 计数产出 `lane-change.txt`/`lane-N.txt` 标记，`[wave-conflict]` prompt 触发 `shared.txt` 冲突写；新增内置命令 `patch-app-wave`（两 lane 并行独立文件）。

## 波次/基线/合并语义

- **基线**：每个 lane 调用在 `call_start` 落盘时冻结 `runs.candidate_tree` 现值为 `calls.base_tree`；波次内各 lane 因 call_start 先于任何本波发布提交而共享同一基线 B；下一波 lane 的 `laneWorkspace` 返回已合并基线。
- **发布序**：`pendingLaneEnds` 排干保证 call_end（含合并）按 callSeq 提交；合并本身（B、候选、P）在有序提交时发生，冲突判定确定。
- **冲突**：文件级三向——B→候选 与 B→P 同路径比较结果（blob 相同或两边都删按已合入去重；不同→conflict）；目录/文件位置冲突同样判冲突。冲突保留候选（tree/patch 留 objects.git），不写发布行、不动指针，调用得 conflict 槽位。
- **回收**：已采集未发布候选为孤立对象可诊断，不 GC。

## E6B 覆盖（`fixtures/workflow/e6b/scenarios.json` → `e6b-wave.test.ts`，真 Git）

E6B-01 并集合入（物化比对文件内容）、E6B-02 冲突保留+指针停先者、E6B-03 相同补丁去重（prev==next）、E6B-04 波内失败其余照常发布、E6B-05 合并抛错无半提交、E6B-06 第二波工作区=已合并基线、E6B-07 乱序完成按序发布（lane.test.ts）。

## 边界

- 冲突不做自动合并、不启动合并 Agent；候选不 GC；`shared` 隔离仍 unavailable（字面量即拒绝）。
- 嵌套 fanout/自由流水线不开放；lane 只能顶层或恰好一层 `parallel()` 直接实参。
- 无 mergeCandidate 能力的 candidateStore 维持 W6a 逐快照语义（端口可选）。

## 裁量点

- `laneWorkspace` 端口失败映射：端口抛 `{code:'unavailable'}` → `failed{unavailable}`，其余 → `failed{internal}`（host 对 reply ok:false 统一打 unavailable）。
- `conflict_json` 单列存 `{files, candidateRef}`（v4 同时加 `base_tree`）。

## 2026-10-25 整合注记

本文保留冻结来源的历史 WF-W8 记录与结果。原文的 call_start 登记先于波次发布要求，不能据历史记录推定当前竞态已消除；本轮另外要求停止/退出必须确认所属清理，这不是原记录已经作出的“stop 返回即确认”声明。

本轮整合修复了缓存登记/发布与停止竞态，并补充 runtime 固定波次权威与退出清理：合法 lane 只可位于无未完成 helper 的真正顶层，或单层 parallel 初始同步 thunk；pipeline、嵌套/重叠 helper、异步延续等拒绝路径在 host/cache 前受限，静态 analyze 不是唯一权威。正常 readonly 异步 helper 与已结清后续波次保留。host callback 私有化，guard/host 使用同一 options JSON 快照。

清理未确认通过独立 owner 错误保留进程/Profile 占用，done/stop 拒绝；Main 保持 needs_reconciliation，同进程活 owner 不能人工标记为普通 stopped。Main 关闭开始同步撤销本地与 service 受理，源码写入已成功的回执仍登记事实。对应红/绿与离线检查见[本轮整合记录](../../acceptance/consolidation-20261025/README.md)。最终窗口、E8 真实矩阵和 WF-W9/Ultra 尚未据此通过；原日期与原结果不改写。
