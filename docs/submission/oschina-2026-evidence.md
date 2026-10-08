# Web Studio Lab 参赛源稿证据索引

本文配套 [作品介绍源稿](oschina-2026.md)。2026-10-08 本地整合稿继承远端 `606556c` 的证据索引。E02–E11 保留 VS001 的历史快照与判定；E01、E12、E14 描述当前本地产品。未推送的提交与本轮文件使用本地链接，不构造尚不可访问的 GitHub 固定链接。

## 快照与判定规则

| 字段                    | 值                                                                 |
| ----------------------- | ------------------------------------------------------------------ |
| VS001 历史仓库快照      | `2466936454658153e47a430ce1da853826f69f69`                         |
| 产品起点                | `536f0a1948e522a09310aa20784ec512476dc7be`                         |
| VS001 方法归档 runId    | `78531515-547a-4d5e-a572-ff6efbf2a80b`                             |
| 归档中的方法修复前 HEAD | `81efecd5c27c94e853db40db206603f1affe5bdc`                         |
| VS001 基准 SHA-256      | `e6e980c11e0ac84baf26c52b5724a9a6706e3de480494aba549293425a2ab928` |
| VS001 任务 SHA-256      | `d3e338da7ff71fa7b69dbe778f9e50d1ea904079f359aaf8f3025b5c08180dcf` |
| VS001 manifest SHA-256  | `1aa8af00d1f6028b60286e3912f44218f781ae286fed0253b14df59ca8cce5c8` |

receipt 的 `methodRevisionBase` 和 environment 的 `gitHead` 属于归档时的现场。方法修复当时未提交，manifest 用逐文件 SHA-256 绑定实际基准；本文的仓库快照包含后来合并的内容，不能替换归档 HEAD。

“源码已存在”“合成自检通过”“真实产品运行通过”分别使用各自证据。`failed / target_missing / performed=false` 始终保留原判定，不改写为通过、跳过或已执行的真实产品测试。哈希完整性不等于执行真实性。

## 论点与证据对应

| 源稿论点                                  | 索引     | 可以支持的范围                                 |
| ----------------------------------------- | -------- | ---------------------------------------------- |
| 六板块空间产品已存在；完整业务闭环未完成  | E01、E14 | 当前源码、本地提交与分阶段实测                 |
| VS001 固定目标、职责分工与首个 slice 范围 | E02-E04  | 契约、fixture 和冻结成功条件                   |
| 页面观察、独立断言与证据校验已有代码      | E05-E07  | 验收端源码及合成反例，非真实 Electron 正向运行 |
| 复现环境、安装与类型检查                  | E08-E10  | 固定依赖、归档命令和原始结果                   |
| 自检 8/8；B01-B05 全部失败且未执行        | E09-E10  | 方法修复后的同一归档运行                       |
| 方法修复与历史证据保留                    | E09、E11 | 新旧方法指纹及归档适用范围                     |
| Apache-2.0、上游边界、现有治理与缺项      | E12      | 当前文件和目录，不证明成熟社区治理             |
| 评分结构、截止与提交材料                  | E13      | 赛事规则的来源与本轮核验限制                   |

## 逐项来源

### E01

**当前产品与历史边界。**

[当前 README](../../README.md)、[运行时](../architecture/current-runtime.md)、[整合合同](../acceptance/integration-20261008/SPEC.md)和[阶段记录](../acceptance/integration-20261008/task-summary.md)为当前入口。空间重制基准为本地 `9e1df45`，观察 Provider 工作包为 `331c47f`；完整整合是否完成以 E14 的最终记录为准。

当前已有 Electron 主进程、preload、六板块 renderer、空间/标签/四窗格、原生网页、Codex/sbx 会话、PTY、任务历史、通知与恢复。`src/vertical-slice/adapter.ts` 仍不存在；当前 Electron 功能不能改写 VS001 的 target_missing 失败，也不能证明母模板、独立检查器或完整 IDE 已完成。

原稿所述“没有 Electron”仅适用于[旧目录快照](https://github.com/JadeSnow7/web-studio-lab/tree/2466936454658153e47a430ce1da853826f69f69)。历史快照保留，不作为当前产品目录说明。

### E02

**冻结场景、五项验收与执行边界。**

[本地 VS001](../acceptance/VS001.md) / [固定 VS001](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/docs/acceptance/VS001.md)。任务只改运行副本的 `src/App.tsx`，一次真实 harness 会话；验收端独立观察与截图。首个 slice 不要求完整 Workshop、编辑器、交互终端、Hono API、多模板或安装包。

这些是成功条件及未来 adapter 的要求，不能作为已经成功执行的证据。

### E03

**实际数据契约。**

[本地 contracts.ts](../../tests/vertical-slice/contracts.ts) / [固定 contracts.ts](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/tests/vertical-slice/contracts.ts)。`taskSchema`、`productEventSchema`、`identitySchema`、`rawLogSchema` 和 `observationSchema` 是严格运行时结构；`ExecuteTask` / `AdapterContext` 定义产品接点职责。文档不另立字段定义或放宽目标。

### E04

**固定页面输入。**

[本地页面](../../fixtures/vertical-slice/page/src/App.tsx) / [固定 fixture 目录](https://github.com/JadeSnow7/web-studio-lab/tree/2466936454658153e47a430ce1da853826f69f69/fixtures/vertical-slice/page)。初始标题为 `Hello baseline`，选择器为 `[data-testid="greeting"]`。fixture 是测试输入，不是 Electron 产品或已完成的 Agent 产出。

### E05

**验收调度、CDP 观察与独立断言源码。**

- [本地 run.ts](../../tests/vertical-slice/run.ts) / [固定 run.ts](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/tests/vertical-slice/run.ts)：创建副本、分类结果、注册清理和写出报告；入口不存在时五项均设为 failed，performed=false。
- [本地 cdp.ts](../../tests/vertical-slice/cdp.ts) / [固定 cdp.ts](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/tests/vertical-slice/cdp.ts)：回环地址边界、Electron discovery、指定 target、导航、原始协议记录与 PNG 采集代码。
- [本地 postcondition.ts](../../tests/vertical-slice/postcondition.ts) / [固定 postcondition.ts](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/tests/vertical-slice/postcondition.ts)：URL/runId/就绪状态、唯一性、可见性、精确文本及观测异常断言。

归档没有执行真实 CDP 路径；源码审阅和合成 transport 自检不能证明真实 Electron 集成通过。`webContentsId → targetId` 映射还需审阅未来产品代码。

### E06

**证据绑定与完整性核验源码。**

[本地 evidence.ts](../../tests/vertical-slice/evidence.ts) / [固定 evidence.ts](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/tests/vertical-slice/evidence.ts)。关键入口是 `baselineFingerprint`、`ProductTranscript`、`verifyManifest`，覆盖基准指纹、事件顺序与身份、产物字节数和哈希等检查。

完整性检查能发现缺失、改变与串用；无法密码学证明 harness 来源、执行者诚实或产品身份映射。本轮发现 B03/B04 独立证据门槛缺口（F08），已修复源码并补充独立负例；正式复验与新方法指纹由 E14 的阶段记录给出，E09 的旧指纹只对应历史方法。

### E07

**合成自检范围。**

[本地 selftest.test.ts](../../tests/vertical-slice/selftest.test.ts) / [固定自检源码](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/tests/vertical-slice/selftest.test.ts)。历史固定快照的八项均显式标注 synthetic，覆盖严格契约、postcondition 反例、串用/顺序/生命周期、改动边界、manifest 以及空 DOM、loading、错误 URL 和单匹配等判定逻辑。通过记录见 E10；不是 B01-B05 的真实产品运行。

### E08

**VS001 历史依赖、命令和类型检查范围。**

以下固定链接用于复现当时归档。当前产品安装使用 pnpm-lock.yaml 与根 packageManager；请遵循[当前开发入口](../../README.md)，不要在当前树执行旧 npm ci。

- [本地 package.json](../../package.json) / [固定清单](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/package.json)：历史固定清单要求 Node.js ≥22.12，并包含 typecheck/selftest/baseline 入口；本地清单已扩展产品依赖和 Node 24 要求。
- [本地锁文件](../../package-lock.json) / [固定锁文件](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/package-lock.json)。
- [本地 tsconfig](../../tsconfig.json) / [固定 tsconfig](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/tsconfig.json)：检查 src 的 TS/TSX、测试与 fixture。
- [验收使用说明](../acceptance/README.md) / [固定说明](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/docs/acceptance/README.md)。

当前没有实际 adapter 可供编译；将 src 纳入范围不等于已经实现 adapter 或自动验证任意动态导出。

### E09

**2026-10-07 当前方法回执与运行现场。**

[固定当前归档目录](https://github.com/JadeSnow7/web-studio-lab/tree/2466936454658153e47a430ce1da853826f69f69/docs/acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b)。

- [本地 receipt](../acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/receipt.json) / [固定 receipt](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/docs/acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/receipt.json)：run、任务/基准/manifest 指纹、产品起点、方法修订起点及命令输出哈希。
- [本地 environment](../acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/run/environment.json) / [固定 environment](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/docs/acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/run/environment.json)：darwin / arm64 / Node v26.5.0、归档 HEAD、未提交方法修复、adapter 哈希为 null。
- [本地 manifest](../acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/run/manifest.json) / [固定 manifest](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/docs/acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/run/manifest.json)：逐文件基准与产物指纹。

### E10

**2026-10-07 原始判定与命令输出。**

[固定 commands 目录](https://github.com/JadeSnow7/web-studio-lab/tree/2466936454658153e47a430ce1da853826f69f69/docs/acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/commands)。

| 原始文件                                                                                                                                                                                                                                                                                                  | 可直接读到的结果                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [typecheck.json](../acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/commands/typecheck.json)                                                                                                                                                                                            | 命令退出 0                                                               |
| [selftest.json](../acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/commands/selftest.json) 与 [selftest.stdout.txt](../acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/commands/selftest.stdout.txt)                                                                  | 8 pass、0 fail、0 skipped、0 todo，退出 0                                |
| [baseline.json](../acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/commands/baseline.json)                                                                                                                                                                                              | 命令退出 1                                                               |
| [run/report.json](../acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/run/report.json) / [固定 report](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/docs/acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/run/report.json) | B01-B05 全部 failed、code=target_missing、performed=false；identity=null |

receipt 的解释字段明确：未调用 Agent、启动 Electron、执行 CDP 观察或生成截图。不存在可以引用为本次正向结果的截图或演示视频。空日志边界不表示观察到了“没有运行异常”。

### E11

**2026-10-06 历史方法归档。**

[本地旧 receipt](../acceptance/preimplementation/d1c9bc9e-4092-4697-83cf-d52d334b7686/receipt.json) / [固定旧归档](https://github.com/JadeSnow7/web-studio-lab/tree/2466936454658153e47a430ce1da853826f69f69/docs/acceptance/preimplementation/d1c9bc9e-4092-4697-83cf-d52d334b7686)。旧自检 5/5，产品五项仍失败；旧基准 SHA-256 为 `92ac18313e5a30a5d72570c138f27ac41d6727d80a74f7bcff085cb67f318f6a`。旧内容与回执保留，不当作当前方法的相同指纹复验。

### E12

**许可、来源与现有治理边界。**

- [本地 LICENSE](../../LICENSE) / [固定 LICENSE](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/LICENSE)：Apache License 2.0。
- [固定 README 的来源边界](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/README.md)：独立历史、未迁入上游代码、迁移时保留来源与许可的原则。
- [本地 .gitignore](../../.gitignore) / [固定 .gitignore](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/.gitignore)：运行记录、构建、环境与常见凭据排除规则。
- [上游固定提交](https://github.com/JadeSnow7/Web-Studio/tree/f377db874f0ecba3390804146776b5e5786d2f86)：仅作 README 指明的参考来源，不借用其能力作为 Lab 运行证明。

当前已有[开发与贡献规范](../../CONTRIBUTING.md)、[Agent协作约定](../../AGENTS.md)、模块依赖 lint 和分层验证入口。旧 E01 快照缺少 CONTRIBUTING 的事实不适用于当前树。安全报告流程、独立第三方许可清单、平台发布与社区规模仍需对应材料；本轮不宣称完成依赖安全审计。

### E13

**赛事条款与报名状态。**

[2026 上海开源软件应用创新大赛官网](https://www.oschina.net/os2026/)，历史核验日期 2026-10-07；2026-10-08 尝试直接读取该官方页面未取得正文，以下保留为历史条款摘要，正式提交前需再次核对。

- 2026-10-07 原稿记录的官方页面搜索索引支持：作品材料截止为 10 月 16 日 24:00；组委会审核后发报名确认邮件；收到确认后按指引提交完整可运行代码的仓库链接、介绍文档（推荐 PDF）和核心功能演示视频链接。
- 四项维度及权重采用本次任务提供的 2026-10-07 核验记录：技术创新 30%、场景落地 30%、开源治理 20%、长期发展 20%。原稿的直接页面抓取未取得赛事正文，不声称保存了官网完整快照；正式提交前再核对官网或确认邮件。
- 未访问报名确认邮件，不把公开仓库、稿件、合并 PR 或其他赛事登记当作本赛事报名证明。
- 官网所列截止未在已取得条款中明确时区。源稿按北京时间安排准备工作，实际要求以确认邮件或主办方通知为准。

### E14

**2026-10-08 本地代码整合与验收。**

- [来源与验收合同](../acceptance/integration-20261008/SPEC.md)：全部工作树及分支候选、只读来源边界、本地提交与禁止发布范围。
- [审查记录](../acceptance/integration-20261008/review.md)：实际缺陷、失败证据、修复和未解决项。
- [当前阶段](../acceptance/integration-20261008/task-summary.md)：本地提交、能力接线、最终验证与缺口。
- [原始基线](../acceptance/integration-20261008/evidence/baseline/summary.json)：类型/构建/单元结果及 Electron 窄窗失败，不能筛除失败后宣称全绿。
- [Main/持久化/MCP 源码指纹与复验](../acceptance/integration-20261008/evidence/phase2b-final-source-manifest-v2.json)：`d9beb8a`，393 项单元通过、8 项既有 live 跳过；这是该阶段快照，不能替代最终验证。
- [Provider 源码指纹与复验](../acceptance/integration-20261008/evidence/phase1-source-manifest.json)：类型、341项单元、定向lint/format与构建通过；8项live未运行不计通过。

- [空间文件与会话观察源码及证据](../acceptance/integration-20261008/evidence/phase3-final-source-manifest-v3.json)：`612cde0`，406 项单元通过，Electron 相关子集 46 通过、1 焦点失败、2 live 跳过；Mac 锁定使原生焦点、真实拖拽和中文候选窗验收待解锁复跑。

- [验证工具修复与新方法指纹](../acceptance/integration-20261008/evidence/phase4a-final-source-manifest.json)：`46cab72`，406 项单元、12 项 VS001 合成自检通过；F08 独立证据门槛与 JSON 字段顺序已修复，历史固定目标和原失败保持。新方法指纹 `94536a5749212a9526ef89c53a3c4b8e39b8f06a2f69d996eff46d0369e3e332` 不替换 E09。

原始证据绑定其运行源码；后续最终验证另记。Provider测试通过不代表产品UI、真实模型、packaged或外部SSH验收完成。

## 后续证据更新规则

1. 在独立产品实现完成后引用新的真实运行目录、产品提交与版本；不要更改当前或历史实现前回执。
2. 只有全部检查实际执行并通过后，才能新增“VS001 固定场景通过”的描述；保持结论范围与场景一致。
3. 分别补充演示视频的可访问链接、对应提交/run、启动说明、正式 PDF 和实际报名信息，不以概念图或合成样本替代。
4. 本文与投稿稿不进入 `baselineFingerprint` 的文件集合；新增这些文档不应改变现有基准指纹。
