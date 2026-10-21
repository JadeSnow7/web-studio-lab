# 参赛证据索引 · 2026-10-16

本索引描述历史回执的只读核查所得；本次 PR 回归另见[整合记录](../acceptance/submission-20261016/README.md)，不追溯改变历史运行结论。仓库内路径是当前候选的相对路径；外部证据使用交付包名和文件名定位，实际可访问链接见[材料入口](README.md)，尚未填写的链接不能视为已交付。原始回执可能含机器路径或测试内容，对外提供前需脱敏，本文不复制这些内容。

## E01

**版本与范围。** [根 README](../../README.md)、[当前运行时](../architecture/current-runtime.md)、[开发规范](../../CONTRIBUTING.md)、根 `package.json` 与 `LICENSE`。录像源仓库为 `JadeSnow7/web-studio-lab`，历史 HEAD 为 `b5531e1ac3b3da7adf000f6ba61f2c5b19a0755f`，原分支 `agent/mota-preparation-20261015` 含未提交改动，故该 HEAD 不能单独标识录像代码；历史复现需其完整源码清单及对应构建指纹。当前候选分支为 `agent/submission-20261016`，实现 commit 为 `120d34777db305b99e9501951363fe64e049a69f`，准确版本与回归另登记于[PR 整合记录](../acceptance/submission-20261016/README.md)。

## E02

**魔塔接入与模型验收。** [手动整合记录](../acceptance/mota-integration-20261015/README.md)、[AI 阶段验收](../acceptance/mota-ai-20261015/README.md)。外部包 `mota-integration-20261015-verified/README.md`、`mota-ai-20261015-verified/report.md` 及后者 `evidence/model-03/result.json`。

- 手动整合：真实目录接入、游戏/编辑器、手动保存、停止重启有对应结果。其单 worker 单测为 1709 通过、18 条件跳过，不能概括为默认并发一次全绿。
- build03 的 model03：普通/金币两局分别 59/61 次工具调用，均通过 12 个有序检查点，终点 MT4 `(11,10)`、HP926、money 7/14。仅改 MT1 `(6,10)` 的 `0→53`。
- 后续 build04 默认 E2E 为 168 通过、22 跳过、0 失败；先前 6 项失败及格式遗留问题保留。build04 的默认 E2E 不等同于重跑 model03。
- OS 探针在真正验证隔离前退出，未证明 OS 写入或网络阻断；UI 聚合历史存在输出上限。

## E03

**魔塔正式成片，独立于 model03。** 外部包 `mota-demo-video-20261015/`：`delivery.json`、`segments.json`、`web-studio-mota-demo-zh.verification.json`、`qa/visual-review.json`、`evidence/validation-2026-10-15T15-30-46-104Z.json`。

成片 `web-studio-mota-demo-zh.mp4`：84 秒，1920×1080，30 fps，H.264，无音频，6,005,717 字节；SHA-256 为 `ac9cd71f793bf00e3f93ff3b8c04f728962e472520aa785471f106839fd8f092`。本次 build04 录像的普通/金币两轮为 58/61 次调用，各 12 个有序检查点，终点与 7/14 对照通过。回执记录完整解码通过、14 个关键帧审阅；本次文档任务没有重新解码或逐帧审片。

`segments.json` 保留实际原片区间与 1、2、4、6.5、15 倍速。剪掉等待与重复停留；差异卡来自本次实际文件。第二轮开局与拾币没有游戏动画画面，以回执说明。清理后观察轮询出现 closed-page，保留原记录；sandbox 停止前没有独立重核 guest PID 消失，不能把 UI 清理确认扩大为该项实测。

## E04

**标准模板与本地存储。** [标准模板说明](../../templates/standard-app/README.md)，源码 `templates/standard-app/server/db.ts`、`templates/standard-app/server/`、`templates/standard-app/agent/`。PGlite 接收模板配置的数据目录；标准 App 初始种子不是“完全空数据库”。源码证明所用机制，具体手帐行为由 E05/E06 各自回执证明，不从模板推定所有生成应用都正确。

## E05

**手帐录前检查与完整 v5 彩排。** 外部包 `journal-recording-preflight-20261016/README.md`、`full-rehearsal-addendum.md`，以及补充说明引用的保存、研究限制、刷新 GET 比较和清理回执。

录前记录仅说明当时状态；随后完整彩排完成新搜索、3 个正文来源读取及显式纳入、正常 UI 保存和刷新核对。经历目标未绑定取消、生成阶段点击验证失败、中文 testid 拒绝及 fresh ref 续跑。AI 保存/刷新与主控独立刷新分别记录。完整准备至退出耗时 41 分 8.045 秒；原 owner observer 仍为 exit 1，含 3 条历史 guard 错误，补充 observer 为 exit 0，不能写成全部零错误。

搜索日志缺失候选 URL 列表，保存的来源字段不证明候选归属。Wikivoyage 是回执校验失败，不据此归因网站 HTTP 拒绝。本文不重审来源正文与建议的逐句语义，也不公开手帐正文。彩排不等于正式录像。

## E06

**手帐正式生成、17 日验收与 18 日补录。** 外部包 `journal-demo-video-20261016/` 的 `formal-generation-acceptance.md/.json`、`formal-research-acceptance.md/.json`、`formal-retry18-acceptance.md/.json`，以及各自引用的完成回执。三次运行与 v5 彩排分别记录。

生成 run `d2e0c322-eaf4-4784-9b14-abd38127b269` 耗时 468.008 秒，6 个文件变更在允许范围；最终类型检查、4 个既有模板测试文件、清单检查和受管构建启动通过。首次清单失败及两次鼠标定位失败保留；键盘路径完成测试保存/刷新，测试文字经 UI 清空后留有空记录。55 份工具回执有 3 个失败、8 个截断，未新增手帐专属测试。

17 日 run `c044720d-5d75-453b-b246-d0ae0880bbd8` 耗时 149.887 秒。新搜索完成，HSLY 正文读取并纳入各 1 条；AI 正常 UI 按 Enter 保存、刷新重选，以及主控独立刷新后的 GET 四字段一致。UNESCO HTTP 403 未纳入；保存刷新后的 Control+Home 被 schema 拒绝，随后普通滚动成功。录屏因窗口 metadata 校验失败而中止，具体失败字段及原因未确认，没有可用 MOV，不能用业务回执补造保存画面；见 `raw-research-save-01/result.json` 与 `raw-research-save-01-recording-correction.json`。

18 日 run `a5994dc7-be02-41d2-baa4-39271511689f` 于 07:51:41.709–07:53:24.989 UTC 执行，耗时 103.280 秒。在原先空白的 18 日重新搜索，重新读取并纳入已知 HSLY 来源；正文散列与 17 日相同，不证明新发现或内容更新。AI 填写后以 Enter 保存，正常导航并重开日期；AI 保存、AI 刷新及主控独立刷新后的 GET 四字段一致。

`formal-retry18-after-ai.json` 和 `formal-retry18-after-independent-refresh.json` 均 HTTP 200、1,872 字节，响应 SHA-256 为 `ecad316d2ff81aa90ea7a475b0b45ab865da6a329070d1e7452a3bb88754fb29`。`formal-retry18-preserved17.json` 与原 17 日刷新后数据四字段相同。18 份 MCP 回执本轮无失败，5 份快照截断，1 份纳入回执有意省略来源正文；源码 patch 为空，Main validation 仍 `not_run`。

以上结果不等于全 UI、停止重启、全部数据库或媒体验收。正式 API 使用 `source` 且无 updatedAt，不与旧手帐 `sourceUrl/updatedAt` 混用。候选 URL 没有投影，来源正文省略，不能独立确认 URL 来自该次搜索、旅游事实或发布主体；商业/非官方来源说明不代表官方核验。

## E07

**技术能力与未演示范围。** `apps/desktop/src/main/workbench/`、`apps/service/src/resource_mcp.py`、`apps/service/src/research-runtime.ts`、`packages/protocol/src/mota-control.ts`、`packages/protocol/src/research.ts`；总体结构见[架构](../ARCHITECTURE.md)。

源码中魔塔工具限定状态/操作/读图/改图；改图 schema 限定 `0→53` 并要求预期散列。研究接口区分打开与显式纳入。协议允许 `candidateUrls` 不等于本次日志实际包含该字段。SSH、PTY、多会话等实现及历史验证见[运行时](../architecture/current-runtime.md)，未在本次两场景中逐项复验。

## E08

**手帐成片、原片与收尾保全。** 外部包 `journal-demo-video-20261016/` 的 `DELIVERY.md`、`web-studio-journal-demo-zh.verification.json`、`final-cut-review-v1/independent-qa.md/.json`、`raw-research-save-02-segments/result.json`、`research-segments-final-qa/raw-independent-verification.md/.json` 和 `journal-final-edit-plan-v2.json`。计划中的待渲染状态保留为编排时点历史，完成状态以最终编码回执与交付说明为准。

成片 `web-studio-journal-demo-zh.mp4` 为 130.000 秒、1920×1080、H.264/yuv420p、30 fps、3900 帧、无音轨、3,255,337 字节；SHA-256 为 `da6e638388a299f7fb276a7b06fe5f16fe301955845bcebbbbd61962edd017cb`。编码回执完整解码通过，独立 QA 重算成片及使用的六份原片散列吻合，并逐张检查 32 张顺序解码样本；主控另查其中 14 张。这是稀疏样本核验，不是逐帧隐私保证。本次文档任务只读回执，未重新解码媒体。

18 日七段原片共 366.086667 秒，既有回执均记录完整解码通过；六处进程时标间隔合计 37.172752 秒，非逐帧精确缺口。最终 15 个片段使用原速及 2×、3×、4×、8×，人工采集/切页/展示/独立刷新、17 日录像失败和 18 日新运行均有说明。正文输入开头未直接录到，完整四字段一致由回执支持。早期快速 seek 抽帧出现文字缺失，顺序解码对照正常；不据此推断原片损坏。前 50 秒生成、后 80 秒研究保存是剪辑时长，不是实际完成耗时。

保全依据 `formal-final-old-journal-independent-review.json`、`formal-final-preservation-freeze-v2.json` 和 `formal-recovery-closeout-20261016T082334Z.md`：旧项目 15–18 日四条记录六字段含 updatedAt 一致；339 个源码与 8 个输出内容、元数据一致，43 条变更清单和 8 项构建指纹吻合。此为列明范围的时点核对，不是全系统审计。

退出前 App 均 stopped/cleanupConfirmed，22 个 run clean；Electron 正常 UI Quit 已发出，随后两个目标 PID 均不存在。原 owner/keeper 的退出方式与退出码未知，PID 消失不等于 exit 0。恢复时 sandbox 已 stopped、端口为空，偏离原四条映射基线，原 owner cleanup gate 未通过。旧魔塔成片是 dataless 云端占位，本轮未读取、下载或重算哈希，只引用 06:11 UTC 历史校验；其当前字节一致性为 `not_run`。首次冻结失败保留；v2 宿主冻结 `passed`，整体保全 `undetermined`，不称所有清理条件无异常。

## 证据使用规则

散列证明所比较文件的字节一致性，不独立证明执行真实、来源授权或功能正确。成功、失败、跳过和未运行分别记载；所有结论限定到其运行和版本。项目级独立检查器、用户接受、新发行版发布、跨平台导出及最终参赛提交，均不能从以上局部结果推定完成。
