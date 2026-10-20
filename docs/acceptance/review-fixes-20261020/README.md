# 评审修复的可移植验收记录（2026-10-20）

地址输入、R5 导出合同及 R6 可信编辑器已通过各自授权的默认验证；最终 R6 独立复核结论为 `ACCEPT DEFAULT AUTHORIZED SCOPE`。这只接受默认本地 fixture 范围，完整 R6 安全验收仍未完成，用户产品接受不由此推定。

本目录发布可读摘要与哈希清单，供另一 clone 理解候选、核对输入及判断验证边界。原始日志、报告、快照和封存材料仅保留在本地，未随本目录交付；下文来源 ID 是原记录标识，不是可访问链接。摘要和原日志哈希不等于读者已取得原日志或重跑验证。

- [结构化回执](receipt.json)：各包结果、实际命令/UTC/退出码、原始回执摘要、50 份已核验 stdout/stderr 摘要及最终 22 项跳过原因。
- [已验证输入](validated-inputs.json)：5,210 个源码输入与 14 个构建产物的仓库相对路径 → SHA-256，保留原聚合值。
- [独立审阅摘录](independent-review.md)：原 R6 审阅及本次文档整理审查的范围、结果与原文摘要。

## 候选与历史状态

验证基线 HEAD 为 `e6bb391df4c1d6c0c6a884d6acdc4061e3027b3b`，分支为 `agent/refactor-modular-20261017`；测试针对该基线加当时的候选字节，并非只针对 HEAD。本记录是提交前的验收快照，不预报自身提交 ID、推送或 CI 成功；实际提交与推送结果以 Git 历史、远端引用及发布回执为准。用户已授权整理、验收后提交推送。

[冻结审计入口](../review-audit-20261018/README.md)记录的是 `b5531e1..e6bb391` 的 252 个变更文件索引，标记 `indexed_not_reaudited`，不证明全量重新审查。[修订计划](../../plans/2026-10-16-post-review-update-plan.md)、[模块化计划](../../plans/2026-10-17-modular-refactor-plan.md)、[R5 计划](../../plans/2026-10-19-r5-export-contract-plan.md)、[R6 计划](../../plans/2026-10-19-r6-trusted-editor-save-plan.md)与 [ADR-0004](../../architecture/adr/0004-mota-trusted-editor-save.md)保留批准时原文；其中 Proposed、未实施和未执行描述是历史状态，当前局部进展以本记录及两份权威文档为准，不能由此补齐计划的全部出口。

本轮整理前 70 个 dirty 路径均已分包：冻结评审基线 7、地址包 7、R5 计划及 8 文件、R6 计划及 47 文件；`app-service.ts` 为 R5/R6 共享路径，因此不重复计数。分包顺序为冻结评审输入、地址修复、R5、R6、本文档闭合；已核对分组树与候选字节，本文不代替实际 Git 提交记录。

## 行为与权威边界

冻结评审基线保留七个既有整改文件：两份评审/模块化计划、三份审计索引、ADR-0004 和 Promise 规则测试装置。B1 将同路径反复 `lintText` 的片段改为逐文件真实 TypeScript Program 输入，保留原 19 用例与生产规则，并补充 Program/映射节点/标准库 Promise 和生产路径 CLI 反例；它修复测试装置的输入失配，不宣称穷尽生产异步异常。审计索引仍不代表逐文件重新审查，已批准计划/ADR 原字节不在本次文档整理中修改。

地址包将输入草稿与当前网页/导航生命周期绑定：迟到状态不能覆盖正在编辑的地址，切资源及 Escape/失焦/提交仍按现有交互结算。受控初始加载与导航观测 fixture 固定竞态刺激，原业务断言保留。涉及 `Browser.tsx`、三个原 E2E、helpers 和两个新增 fixture；其补丁摘要见回执。

R5 将标准 App 与 edu 的源码导出统一为最多 **256 文件、524288 字节**，协议、helper、service 与 Main 导出端保持同一合同；Mota 导出仍为 unsupported，不扩大为 8 MiB，也不沿用魔塔导入的 64 MiB 预算。产品原件和冻结输入不因验证失败被改写。

R6 的文本编辑页使用固定产品 URL `wsl-editor://mota/index.html` 与独立原生 View；仅专用 `motaEditor` preload，不能获得工作台 `studio`。Main 每次核对 sender、顶层 frame、精确 URL、构建资产、可见会话及实例/版本权威。保存只到副本 `project/floors/MT1.js` 与 `_server/config.json`，单文件最多 256 KiB，经私有分块管道及 guest/server 单一写入队列结算。来源游戏与 `/editor.html` 无产品 bridge，旧 `/writeFile` HTTP 写入口返回拒绝；HTTP 读取不授予保存权或刷新版本权威。

隐藏、切空间、关闭、导航或实例变更撤销权限；重开须重新读取。草稿保留原 hash，冲突不静默更新基线；迟到提交保留原操作事实，unknown 不重放、不提前释放占用。原生退出保留所属句柄直到 terminal disposal。Main pre-admission 修复保留旧 `pane_limit` 错误映射、合法窗口空间隐藏与全局同步撤权；无效/过期请求先拒绝，后台显示权限不扩大。R4 的 `mota_native_tools_unverified` 拒绝门禁保持，未放行产品模型。

接口与交互详见[当前运行时](../../architecture/current-runtime.md)和 [UX 契约](../../../UX-CONTRACT.md)。这些应用层门禁不证明 guest 同 UID 的 OS 文件/进程/网络隔离，也不证明完整 Workshop/比赛检查器闭环。

## 验证结果及版本绑定

工具链为 Node **24.21.0**、pnpm **10.34.6**、Python **3.9.6**、macOS **26.6.2 arm64**、Electron **44.5.1**、Playwright **1.63.0**、Vitest **5.0.3**。原回执及本次只读版本核对支持这些值；R6 角色包装器的实际 CLI `--model gpt-6.1-sol` 只证明参数选择，不是后端身份认证，也不是产品内模型验证。

| 包/检查               | 已记录结果                                                | 输入和适用范围                                                                    |
| --------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 地址固定竞态          | 旧 2 通过/9 失败 → 新 11/11；相关原业务 4/4               | 同一最终回归；新对照仅替换修复前 Browser 实现                                     |
| 地址完整检查          | Vitest 2075 通过/18 跳过；Node 174；external 6            | `pnpm check`，exit 0                                                              |
| 地址默认窗口          | 179 通过/22 跳过/0 失败/0 flaky；201 项                   | 新构建；原 190 保留，新 11 全通过                                                 |
| R5 固定导出回归       | 14 失败/37 通过 → 51/51；相关 347/347                     | 同一最终 51 项；旧离线回执与后续窗口分开                                          |
| R5 完整检查/自检      | Vitest 2126 通过/18 跳过；Node 174；external 6；自检 12   | 格式失败修正后完整检查 exit 0；离线自检不是产品接受                               |
| R5 窗口               | Workshop 创建/导出/异常/重启 1/1；默认 179/22/0/0，201 项 | 后续同源码窗口验证；未冒充重跑旧离线命令                                          |
| 最终 R6 完整检查      | Vitest 2248 通过/18 跳过；Node 177；external 6            | 全阶段到达，exit 0；实际 localhost server **71/71**，早期 B1 **70/70** 为历史计数 |
| 最终 R6 自检/定向窗口 | 自检 12/12；窗口 8/8                                      | 六项 R6 加原两项业务回归；exit 0                                                  |
| 最终 R6 默认窗口      | **185 通过/22 跳过/0 失败/0 flaky**，207 项               | `run-jknbt5`；原 201 保留，新增六项全过；零重试，新构建与所属原生退出确认         |

R6 Main 兼容性新增四个相同反例先 4 失败、后 4 通过，相关六文件 127 项通过；之后才完成上述八项窗口与默认复验，不能只凭单测关闭窗口出口。

最终实际命令分别为 `pnpm build`、`node scripts/run-e2e.mjs e2e/mota-editor.spec.ts e2e/workshop-actions.spec.ts e2e/workspace-upgrade.spec.ts --grep 'R6 default|App operations stay|A03 / A04 / A05'`、`pnpm check`、`pnpm baseline:selftest`、`pnpm test:e2e`。精确 argv、时间和退出码在结构化回执。最终完整检查为 **2026-10-19T23:50:48Z–23:53:30Z**；最终默认命令为 **2026-10-19T23:53:35Z–2026-10-20T00:02:04Z**，均 exit 0。默认入口实际执行新构建，不把 `--list` 当执行结果。

最终历史源码聚合为 `7976865df924e64e6cda307b9f844711a5c30a4f944d330f624a5c2e8f81dd5a`；构建聚合为 `172b97ab4f634c9d52fd4001d9aa90c0ea6cac31bd39b51a4ae812770d2dd010`。每个 path→hash map 的聚合输入精确为 Python `json.dumps(mapping, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")`，不追加换行；非 ASCII 字符必须转义。清单文件本身可保留字面 Unicode，计算时仍须使用上述规范形式。从仓库根目录运行以下代码即可从公开清单重算并断言两项聚合，不要求取得原日志：

```sh
python3 - <<'PY'
import hashlib
import json
from pathlib import Path

manifest = json.loads(Path("docs/acceptance/review-fixes-20261020/validated-inputs.json").read_text(encoding="utf-8"))
for kind in ("source", "build"):
    mapping = manifest[kind]
    canonical = json.dumps(mapping, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    aggregate = hashlib.sha256(canonical).hexdigest()
    assert aggregate == manifest[kind + "Aggregate"], (kind, aggregate)
    print(kind, aggregate)
PY
```

其他包各自的历史聚合见回执，不能与最终 R6 混用。

本文档整理仅允许两份权威文档状态段和本目录四文件变化。清单保留的是测试时原文档哈希，不将新文档哈希替换进原聚合；其他产品、测试、配置、依赖及全部构建产物保持已验证字节。既有产品运行结论据相同输入继续适用，旧 `pnpm check` 没有检查新文档或未来提交。本次文档链接、格式、公开重算示例及一致性检查通过，独立审查关闭 Unicode 序列化说明的 P2 后接受文档/提交准备；具体范围与摘要见独立审阅摘录。文档收尾没有重跑产品单测、构建或窗口测试。

## 失败与未覆盖项

旧锁屏/中断/机制实验原样保留。地址新对照证明当前竞态修复，不重构旧运行的因果链；旧地址归因仍为 **likely**，四项历史单测根因仍 **undetermined**。R5 旧超时与首次格式失败分别保留，最终绿色不证明超时根因已解决。

R6 旧 selector/fixture、退出挂起和 4 通过/2 失败保留。退出问题曾由实际 `showErrorBox` 确认：View 清空 WebContents 后触发 destroyed，`getFacts` 读取空引用进入同步 NSAlert；所属句柄和 terminal disposal 修复后才有正常退出证据。最新首轮 CSP 为 5/1，修正为等待真实异步 `frame-src` 事件后 6/6；未伪造事件或放宽 CSP。首轮默认为 183/22/2，两项 Main 提前准入兼容性失败在四个相同单测反例先失败后通过后，以原窗口用例及完整默认套件复验。首次完整检查为 2243 通过/18 跳过/1 MCP stimulus 失败，Node/external 未到达；最终检查未重现，但该 MCP 根因仍 **undetermined**，不归于 Main 修复。

默认测试使用实际 Electron、键鼠、Main、service、编译内置 server、私有帧转发、磁盘写入/读回和回执；fixture 替代导入接收、guest 启动、端口映射，游戏是合成读回页。六项覆盖两文件缺失/创建/保存、hash、中文/emoji、HTTP 拒绝、窄 bridge、CSP/原生导航撤权、关闭/隐藏/切空间、迟到提交、幂等、重启冲突草稿及正常退出。它不证明真实魔塔路线、Setup、Linux guest 或内核隔离。

22 项默认跳过逐项保留在回执，涉及需显式授权的真实 sandbox/model、Mota/edu/标准 App live、观察/研究相关 live 及 packaged 目标；跳过不是通过。真实 guest 保存、产品模型/live、S4 OS 隔离、packaged、物理音频、签名/发布/部署均未在这些包完成。当前候选远端 CI 未验证；历史 CI 仅属于原提交。桌面确认与同期原生观测不证明持续真人交互，缺失 CG 状态仍为 unknown。完整业务/安全出口、合并与用户接受没有被默认绿色关闭。

## 原始来源 ID

| 标识                                            | 用途                                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| `address-input-fix-20261019T064230147345Z`      | 地址最终回执、README、e2e-ledger、package.patch；包含 before/after 与默认命令 |
| `r5-export-contract-20261019T082235828832Z`     | R5 同一 51 项 before/after、347 关联、离线完整检查/自检/构建                  |
| `r5-export-contract-20261019T101517914991Z`     | R5 同源码 Workshop/default 窗口与最终接受                                     |
| `r6-trusted-editor-save-20261019T231256525294Z` | R6 最终输入/命令/结果、CSP 与 Main 修复、历史保全、独立审阅                   |

具体命令标签、run-ID、原回执/日志/审阅的 SHA-256 均在 `receipt.json`，不链接忽略目录或宿主绝对路径。再次验证须在明确授权与满足环境条件后产生新的独立记录，不能借本文档自动启用 live。
