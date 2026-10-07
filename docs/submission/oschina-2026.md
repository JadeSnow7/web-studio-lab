# Web Studio Lab

## 2026 上海开源软件应用创新大赛作品介绍

**项目定位：以运行结果为依据的 AI Web 开发工作空间。**

本文为可审阅、可导出 PDF 的参赛源稿，证据截止日期为 **2026 年 10 月 7 日**。对应仓库快照为 main 的 `2466936454658153e47a430ce1da853826f69f69`。当前交付是可复跑的验收基准，**尚无可运行的 Electron 产品，尚未完成真实 Agent 到页面验收的闭环**。后续实现、视频和报名回执补齐后，应依据新的证据更新本稿。[E01](oschina-2026-evidence.md#e01)

| 项目 | 信息 |
| --- | --- |
| 作品名称 | Web Studio Lab |
| 代码仓库 | [JadeSnow7/web-studio-lab](https://github.com/JadeSnow7/web-studio-lab) |
| 开源许可 | Apache License 2.0；依赖适用各自许可证 |
| 当前可复现内容 | VS001 验收执行器、固定页面 fixture、契约、自检及实现前失败证据 |
| 负责人、团队与参赛赛道 | 待按实际报名材料补充；本稿不代表已选定赛道 |
| 报名确认与演示视频 | 均待补材料，不声明已完成 |

正文按技术创新 30%、场景落地 30%、开源治理 20%、长期发展 20% 组织。赛事提交条款和核验范围见 [E13](oschina-2026-evidence.md#e13)；各项项目事实的固定提交链接见[证据索引](oschina-2026-evidence.md)。

## 一、技术创新（30%）

### 1. 项目背景与问题

AI 修改代码后，仍需确认改动是否发生、当前页面是否来自本次运行、页面结果是否满足要求，以及日志和截图是否能够追溯。Web Studio Lab 选择把这些问题写成独立验收条件，先建立可复跑基准，再接入产品实现。

目标工作空间采用 Workshop / Browser 双区：前者承载项目编辑、Agent、终端与构建诊断，后者承载页面预览和调试。这是 README 中的产品规划；当前仓库没有该 Electron 界面及运行入口，不能用布局设计或上游项目能力替代本仓库的运行证据。[E01](oschina-2026-evidence.md#e01)

### 2. 已实现的验收方法

当前代码形成了三项可检查的方法设计。这些方法已有源码、合成自检和实现前失败记录；真实产品的正向执行仍待验证。

- **先冻结任务与改动边界。** VS001 固定输入、选择器、目标文本和唯一允许修改的 `src/App.tsx`。每次运行复制未改动的 fixture，并生成新的 runId 与任务指纹。任务和事件由严格的 Zod 契约校验。[E02](oschina-2026-evidence.md#e02) [E03](oschina-2026-evidence.md#e03) [E04](oschina-2026-evidence.md#e04)
- **执行与判定分工。** 未来产品 adapter 负责调用真实 harness 和启动应用；验收端自行连接指定 CDP target，读取页面状态、执行独立 postcondition、采集截图。adapter 不能代交 DOM 结果、通过布尔值或预制截图。当前已有验收端代码，没有产品 adapter。[E02](oschina-2026-evidence.md#e02) [E05](oschina-2026-evidence.md#e05)
- **把结果绑定到同一次运行。** manifest 记录任务、基准、运行身份及产物的 SHA-256；receipt 另绑定 manifest 和命令输出。合成自检覆盖串用 run、内容篡改和证据缺失等反例。哈希用于发现变化和混用，不能独立证明执行者或 adapter 诚实。[E06](oschina-2026-evidence.md#e06) [E07](oschina-2026-evidence.md#e07)

项目希望通过这些约束减少错误宣告完成的情况。目前没有效率提升、真实任务成功率、用户使用效果或优于同类工具的对照数据，不提出相应量化结论。

### 3. 技术架构与实现状态

| 层次 | 职责与代码位置 | 当前证据边界 |
| --- | --- | --- |
| 固定任务与输入 | `fixtures/vertical-slice/page/`；`contracts.ts` | React/TypeScript 输入与严格契约已存在 |
| 验收调度 | `tests/vertical-slice/run.ts` | 新副本、运行目录、超时、结果分类和证据写出已实现；入口缺失分支已实测 |
| 页面观察与断言 | `cdp.ts`、`postcondition.ts` | CDP 连接、导航、DOM 读取和 PNG 采集代码已存在；合成 transport 验证部分逻辑，未连接真实 Electron |
| 证据组织 | `evidence.ts` | 文件清单、指纹、事件/日志绑定与 manifest 核验已实现；已归档真实失败记录 |
| 产品接点 | `src/vertical-slice/adapter.ts` | 当前不存在；真实 harness、Vite/Electron 生命周期尚未接入 |
| 工作空间产品 | Electron 主进程、preload、renderer、Workshop / Browser | 规划目标；当前没有对应可运行产品 |

技术依赖和类型检查范围由 `package.json`、`package-lock.json`、`tsconfig.json` 记录。首个 slice 只要求固定页面闭环，不包含完整编辑器、交互终端、Hono 业务 API、多模板、多 Agent、持久化历史或安装包。[E02](oschina-2026-evidence.md#e02) [E08](oschina-2026-evidence.md#e08)

## 二、场景落地（30%）

### 1. 固定场景与真实可运行范围

首个场景把唯一可见的 `[data-testid="greeting"]` 标题从 `Hello baseline` 改为 `Hello Web Studio`。预期过程是一次真实 harness 会话修改运行副本，由 Electron 展示页面，再由验收端通过同一 CDP session 观察、断言并保存截图和日志。**这是冻结的成功条件，尚未发生成功的产品运行。**[E02](oschina-2026-evidence.md#e02)

当前可实际执行的是安装测试依赖、类型检查、合成自检和生成实现前失败报告。Node.js 要求为 22.12 或以上，首次安装需要 npm registry。此阶段不需要真实 Agent 凭据或 GUI。[E08](oschina-2026-evidence.md#e08)

```sh
npm ci
npm run typecheck
npm run baseline:selftest
npm run baseline
```

最后一条命令当前应退出 **1**，原因必须在 report 中确认是 `target_missing`，不能只凭非零退出码认定预期失败。安装、加载或环境错误也可能返回非零。此命令只运行验收基准，不能启动尚不存在的 Electron 产品。[E01](oschina-2026-evidence.md#e01) [E10](oschina-2026-evidence.md#e10)

### 2. 已保存的验收结果

2026 年 10 月 7 日方法修复后的当前归档 runId 为 `78531515-547a-4d5e-a572-ff6efbf2a80b`，运行环境为 macOS arm64 / Node v26.5.0。类型检查退出 0；合成自检 **8/8 通过**，没有 skip 或 todo；产品验收退出 1。[E09](oschina-2026-evidence.md#e09) [E10](oschina-2026-evidence.md#e10)

| 检查 | 冻结的成功条件 | 归档结果 |
| --- | --- | --- |
| B01 | 真实 harness 成功退出，且只修改允许文件 | failed / target_missing / performed=false |
| B02 | 本次 Electron 进程、CDP target 和页面身份一致 | failed / target_missing / performed=false |
| B03 | 直接读取本次页面 DOM、URL、runId 与就绪状态 | failed / target_missing / performed=false |
| B04 | 标题唯一、可见、精确匹配，观测窗口无捕获异常 | failed / target_missing / performed=false |
| B05 | 同一 session 的截图、原始日志与 manifest 可核验 | failed / target_missing / performed=false |

五项结果来自同一个缺失入口，表示五项成功条件均未满足；不表示已经执行五次真实产品运行。该归档没有调用真实 Agent、启动 Electron、读取真实 CDP 页面或生成截图。**8/8 自检通过不能换算成产品验收通过。**[E10](oschina-2026-evidence.md#e10)

当前基准 SHA-256 为 `e6e980c11e0ac84baf26c52b5724a9a6706e3de480494aba549293425a2ab928`。归档记录的 Git HEAD 是修复前的 `81efecd5c27c94e853db40db206603f1affe5bdc`，当时方法修复尚未提交；精确内容由逐文件哈希绑定，不能把本文仓库快照误写成归档运行时的 HEAD。10 月 6 日的旧方法归档原样保留。[E09](oschina-2026-evidence.md#e09) [E11](oschina-2026-evidence.md#e11)

### 3. 产品落地仍需补齐的证据

真实 adapter 完成后，应在不更换冻结输入和判定条件的情况下复验：B01-B05 全部 `passed / performed=true`，保留真实 harness 输出、代码 diff、Electron 页面身份、原始 CDP 请求/响应、PNG、report 与 manifest。页面身份映射及 harness 来源还需结合产品代码审阅。即使该场景通过，也只证明这个固定任务，不能推广成完整 IDE、通用全栈开发或安装包交付。[E02](oschina-2026-evidence.md#e02)

## 三、开源治理（20%）

### 1. 已有治理基础

- **明确许可与来源。** 仓库提供 Apache-2.0 LICENSE；README 指明原项目 `JadeSnow7/Web-Studio` 及参考提交 `f377db874f0ecba3390804146776b5e5786d2f86`。本仓库从独立 Git 历史开始，截至本文快照没有迁入原项目源码、设计正文或二进制。未来迁移需逐项保留版权和第三方声明。[E12](oschina-2026-evidence.md#e12)
- **固定测试依赖与入口。** npm 清单、锁文件、类型检查配置和验收命令均公开；固定 fixture 与断言可被审阅。锁定版本便于复现，不等同于完成依赖安全审计或第三方许可清单。[E08](oschina-2026-evidence.md#e08)
- **保留方法变更与失败历史。** 已公开新旧实现前回执、命令输出、report、manifest 与输入快照；方法修复更换了指纹并说明旧记录的适用范围。[E09](oschina-2026-evidence.md#e09) [E11](oschina-2026-evidence.md#e11)
- **区分运行产物与可公开证据。** `.gitignore` 排除本地 `records/`、构建输出、环境文件和常见凭据；已审阅的基线证据另存于 acceptance 目录。忽略规则不能保证脱敏完整，正式视频和运行产物仍需人工检查。[E12](oschina-2026-evidence.md#e12)

### 2. 尚未建立的治理能力

当前快照没有独立的贡献指南、安全报告流程、CI workflow 或完整第三方许可说明，也没有安装包与跨平台发布验证材料。不声明已有多维护者组织、活跃用户社区、企业部署或商业成果。[E01](oschina-2026-evidence.md#e01) [E12](oschina-2026-evidence.md#e12)

后续治理应从可复现问题报告、贡献流程、依赖声明、自动检查及版本发布说明逐项补齐；这些属于路线，不是当前交付能力。

## 四、长期发展（20%）

项目沿着“固定场景成功，再扩大工作空间能力”的顺序推进。以下为建议路线，不代表已完成或已承诺具体交付日期。

| 阶段 | 推进内容 | 可审阅的完成依据 |
| --- | --- | --- |
| 首个真实闭环 | 接入真实 harness、最薄 Electron 宿主和运行资源清理 | 同基准的新 run：B01-B05 全部 passed；真实日志、截图和清理结果齐备 |
| 参赛材料 | 固定产品版本、干净环境复现、作品介绍和演示视频 | 运行步骤可复现；视频对应提交与 run；收到报名确认并核对提交指引 |
| 工作空间扩展 | Workshop / Browser、编辑与运行反馈、终端等规划能力 | 每项新增能力有独立条件、失败状态和真实运行证据；不借用 VS001 结论 |
| 持续维护 | 贡献流程、依赖与许可治理、CI、版本发布与平台适配 | 可公开检查记录、来源声明和逐平台验证；维护分工按实际情况补充 |

后续判断重点是：新的场景是否减少人工重新描述和复验成本，失败是否可定位，结果是否方便他人复核。这些需要真实任务数据；当前没有对应指标、预算、合作方或团队维护承诺可供证明。

## 五、提交材料状态与使用说明

官网列出的材料提交截止为 **10 月 16 日 24:00**，收到报名确认邮件后按邮件指引提交代码仓库链接、作品介绍文档和演示视频链接。本稿按北京时间安排准备工作，官网条款未明确时区；实际提交应遵照确认邮件或主办方通知。[E13](oschina-2026-evidence.md#e13)

| 材料 | 当前状态 | 待补内容 |
| --- | --- | --- |
| 代码仓库链接 | 已有公开仓库与验收基准；不足以证明完整产品可运行 | 真实 Electron 闭环、固定产品版本、启动与复现说明 |
| 作品介绍文档 | 本 Markdown 源稿与证据索引已形成；PDF 为审阅草稿 | 随实现更新能力与证据，再确认正式提交版本 |
| 演示视频链接 | 待补；当前未发现可支撑本作品核心流程的已交付视频 | 真实操作录像、可访问链接、对应版本/run 和脱敏检查 |
| 报名确认与团队信息 | 未核验；不推定已完成报名或获准提交 | 实际确认回执、负责人、团队信息和报名赛道 |

本文只用于当前材料准备，不代表作品已经具备正式参赛交付条件。后续更新应新增证据引用和明确的能力范围，保留现有失败基线；本次文档工作不修改 acceptance、fixture、测试、依赖锁或 vertical slice 产品实现。
