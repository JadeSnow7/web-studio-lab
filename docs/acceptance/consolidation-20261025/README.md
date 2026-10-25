# 2026-10-25 本地候选整合记录

> 分批提交说明（2026-10-25）：下文记录此前未提交整合候选的准备与执行过程，“当前”“尚待生成”“未提交”等措辞属于当时状态，不能作为本分支验收结论。本批从已发布 OPS `bf05966c52c7b2cfe584c4a5b991b0a600040141` 继续，重放 I4 最终修复及 I5 最终文档，并完整保留冻结树 `9a3685d9ed50270093e0d45dfc831d7b59f92c4b` 的六项 E2E 修正与两项单测配置修正。#19 文档来源为 `16d942bfe606d2f1232fbfdfdc4658cee1d5053d`，采用本地文档协调提交，不表示 #19 已合并；#20 已在 main 合并，收尾文档原字节沿用。本批排除原始证据、原始附件与 E8 实验入口，保留本地清单，不把这些材料称为已公开交付。验证仅限静态、离线单测与构建；Electron 窗口、真实模型、guest 写入及新 CI 未运行。Harness #18/#22/#23 的已知审查阻塞仍未修复，不能称为可合并。具体本地命令、版本、结果和文件哈希在本批仓库外报告中保存；下文历史通过数不代替当前复验。

本轮已把 Harness、OPS/Browser、Workflow 与本轮修复整合到本地未提交候选；最终构建和完整默认 Electron 范围（包含 workflow/shutdown/source 等受影响窗口）验收待主代理执行。固定回执入口为 `/Volumes/Developer/WSLConsolidation/2026-10-25/final-validation-01/summary.json`（尚待生成）；当前状态、最终源码哈希和窗口结果以该仓库外回执为准。历史 PR、设计采纳、旧 live/fixture 结果不是本次用户验收。

## 来源和冻结点

候选 HEAD 是 `ade7a6bd07c7d09b05a59e89fe799f9d7c481608`，不能代表未提交内容。I3 冻结树为 `df1626062d032a82fdf3bc81930393d9e9ddec7e`；I4 修复后、I5 文档前的完整内容树为 `720745f79355270de2926ff313fcfa54b4b8f42f`。I5 只整合 PR19/20 文档与检查入口，不改产品源码；最终全树 binding 由仓库外回执记录。

- I1：保留 main/edu 基线与冻结来源，main 基线独立检查已完成；原 dirty 来源、原 index、refs 与原始历史证据保留。
- I2：按 #27、#18、#21、#22、#23、#25+#26 整合 Harness 栈。主线 edu admission 新增 fixture 的两处缺 harness 字段已最小修复，原拒绝断言不变；首轮失败保留，后续 I3 全量覆盖整合结果。
- I3：按 gate、OPS/Browser、shared OPS 与74个必要历史闭包分批整合。发送等待窗口的旧 resources 闭包在 red03 确定丢失新目标后，改为从同一 latestWorkspace 读取 session/resources；red01/02 只作不适用探针保存，未据此断言产品问题。
- I4：仅迁冻结 Workflow 与裁决后的 shared hunks；随后依次导入 W8 publication、runtime、cleanup 和 cleanup-priority 修复。Main 保业务授权/持久事实，service 保唯一执行 kernel，不因旧文档的进程放置文字重构代码。
- I5：PR19 的 ADR/设计/计划与 PR20 的历史收尾记录保留原日期、原采纳与原结果，新增 dated reconciliation。MHC-W8/W9 与 WF-W8/W9 明确区分。

## 已执行检查与保留失败

本机外置证据根目录（不是仓库文档链接）：`/Volumes/Developer/WSLConsolidation/2026-10-25/`。源快照与每批 before/after tree、binary patch、内容 SHA 见对应 preparation/execution 目录；最终回执应先核对 source binding。

| 范围           | 已确认事实                                                                                                                                            | 仓库外证据目录                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| main 基线      | 独立全量检查通过；1449 Vitest 通过/15跳过、178 Electron 通过/16跳过                                                                                   | `validation-baseline-01`                                                               |
| I2             | 首轮 full unit 的缺 harness fixture 失败原样保留；两次最小 fixture fix 后复验，后续 I3 全量也覆盖                                                     | `validation-i2-01`、`i2-execution-01/review-fix-02`                                    |
| I3 目标冻结    | red03 直接记录 confirmTask.targetRef:null；修复后 target-binding 7/7通过                                                                              | `validation-i3-target-red-01/02/03`、`validation-i3-target-green-01`                   |
| I3 全量        | 类型/lint/格式/docs/build及离线附加项通过；1765 Vitest 通过/27跳过、263 Electron 通过/17跳过，源码稳定                                                | `validation-i3-full-01`                                                                |
| W8 与 shutdown | 独立确定性红/绿：发布屏障、停止/发布、固定波次绕过、guest 清理未确认与Profile占用、pending launch、Host→Main 自动待核对、source apply成功回执取消竞速 | `w8-repair-lab/checkpoints/01-publication` 至 `04-cleanup-priority`、`i4-execution-01` |
| I4 最终离线    | Node24.21.0；完整typecheck、维护与changed ESLint/Prettier、check-docs通过，2157 Vitest通过/27跳过，前后内容绑定稳定                                   | `i4-execution-01/14-source-apply-offline-checks`、`15-product-freeze`                  |
| 当前最终窗口   | 待主代理按冻结源码执行；新增正常关窗/清理失败窗口用例仅完成类型/lint检查，尚无本轮实际运行结论                                                        | 最终 execution-status/receipt                                                          |

I4 检查中测试替身类型错误与首次错误 cwd 的既有23例探针均保留，没有当作候选通过依据。source apply 首个载荷带 mode 的探针被正确边界拒绝；有效载荷的两条红例才证明成功回执被取消错误覆盖。坏/缺失/未应用回执、非零退出与清理未确认仍保持失败正控。源码 apply 已成功而取消竞速时，Main 必须保留 apply 事件/appliedAt，writer在结清后释放。

## 当前范围和未运行项

Workflow 的实际隔离适配器仅 Codex native；已取得的历史真实运行证据仅覆盖 `codex:default`，当前候选未做真实多 Profile 矩阵验收；成员表由 Main 每次受理时冻结的 Profile 快照生成。普通会话 Claude Code ACP 接线不能推导 Workflow ACP 支持。MockHarness 3×2 是离线 fixture，不是真实矩阵。E8 真实矩阵、WF-W9/Ultra、MHC-W9 Gemini/Cursor、remote、Board/Handoff/Bot/会议及完整持久 Lane/AppInstance、多方案阶段仍未据此实施或接受。

当前产品代码和聚焦离线结果不是最终构建、窗口或用户接受。主代理将在完整默认 Electron 范围（包含 workflow/shutdown/source 等受影响窗口）完成后写上述固定仓库外回执；不为更新结果改动已测源码。没有运行新 live 模型/sandbox，没有 commit、push、PR、发布或删除工作树。

## 历史证据和格式边界

74个必要历史闭包中73项保留来源原字节；OPS README 的唯一私有 prompt 超链接已明确改为原路径代码文本并附2026-10-25注记，原字节仍在封存快照。不能据此声称所有历史链接闭合。PR20 收尾文档原字节保留，只表示2026-10-14的历史事实。

完整候选补丁的 `diff --check` 仍因4个原样 `.txt` 输出中的16行尾随空白返回非零；原样日志保持原字节，人读 README/SPEC 无此例外。未扩大忽略规则。精确路径/行号与 SHA 登记在 `i3-preparation` 与本轮执行回执；维护源码检查通过不能改写成全补丁 diff check通过。
