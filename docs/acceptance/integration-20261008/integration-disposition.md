# 来源裁决与实施状态

[sources/file-ledger.json](sources/file-ledger.json) 是基于重制基准 `9e1df45` 的候选裁决快照，2974 条表示跨工作树来源记录，不是独立文件或完成项数。`adapt=123`、`migrate=66` 表示当时的适配/迁入要求；同一路径可因不同来源拥有不同裁决。最终实现归属由下表和阶段源码 manifest 说明，不改写原始来源报告。

| 来源能力                                         | 当前处理                                                                                | 实施证据                                                             |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| delivery Browser/File/Terminal/SSH 观察 Provider | 迁入并适配 Main 稳定资源身份，修复 dispose、来源、取消与输入边界                        | `331c47f`、`c97b673`；Phase1、Phase2a manifest 与回执                |
| delivery local/SSH 终端及环境                    | 服务、Main、MCP 与空间界面已接入；最终验证尚未完成                                      | `c97b673`、`d9beb8a`；Phase2b v2 unit 393 passed、8 live skipped     |
| task5 与 delivery 共享文件差异                   | 保留 delivery root-frame AX、严格 OSC、文件根替换/代次/watch 等修复；独立差异按责任适配 | 来源差异表与 Phase1/2 审查                                           |
| eb15、主树、7ba6、9630                           | 保留独立修复，既有空间能力由重制基准承载；不恢复旧壳                                    | `9e1df45`、逐来源台账；自拖/历史版本/窄窗回归已过；原生拖拽待解锁    |
| architecture、guestbrowser、integration、VS001   | 核对已纳入实现和历史证据，避免整分支覆盖                                                | 来源台账；VS001 复核器独立门槛及字段比较已修复，原固定目标和历史保持 |
| 远端参赛材料 606556c                             | 两份正文、README 和 exporter 已适配当前本地能力及链接边界                               | `46cab72`；9 页 PDF 已独立检查，后续稿件变化须重新导出               |

## 未采纳及理由

| 分组           | 未采纳内容与理由                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 旧业务权威     | 旧 renderer domain/space、state/workbench/preview/runs/terminal 写入口不恢复；Main 工作台与窄 IPC 继续拥有事实                       |
| 旧外壳         | GlobalWorkshop、旧 Workbench、工作现场/终端容器和对应壳测试不整份覆盖；能力进入当前空间页、Session/Panes/Sidebar，保留六页及通知归属 |
| 固定身份接线   | 固定 TaskFlow、拼接环境身份、以 PTY sessionId 代替 resourceId 和旧聊天上下文不迁入；local/SSH 功能继续接入 Main 冻结的身份           |
| 旧工具链及规则 | 不整份覆盖旧 npm/package/锁、初始化 AGENTS、重复 CLAUDE 或过时说明；保留当前 pnpm 产品与 VS001 联合入口、历史原字节                  |
| 过期审计       | premium-audit.json 不进入当前提交和成功证据；旧空 findings 不证明本轮代码通过                                                        |
| 不可核对来源   | Task5 的 324 个非脏旧文件实际字节未知，只保留明确标注的 committed fallback；不从未知字节迁入                                         |

历史失败、截图、锁文件归档和 sealed 证据均保留。未用作当前成功证明不等于删除这些证据。来源表中旧 `state/workbench.ts` 或 `WorkbenchPanel.tsx` 的 migrate 表示其中独立能力需要承接，不表示恢复旧容器；新模块归属以各阶段 manifest 为准。
