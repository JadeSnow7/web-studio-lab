# 空间页重制 SR-1

实施已完成，自动回归通过；原生窗口核心布局、主题修复和菜单排序已由主线程复核。此记录只判定本轮重制范围，不授予完整业务或发布验收。真实 macOS 中文输入法候选窗口、真实模型 / guest 链路和打包产物未验证。

## 交付内容

以 `4ab5581` 的六个全局页面和分组承载新版空间运行能力。首页、空间、资源、会话、任务及底部设置直接可达；空间切换器、垂直标签和最多四窗格只属于空间页。个人会话保留独立作用域，其他业务消费者统一读取 Main 工作台快照，旧空间 store、失效 IPC 与 `sidebarMode` 写入口已退役。

全局按钮列和空间标签整组浮动或固定；右侧只承载通知，显式点击图钉才占据布局。左右固定偏好分别保存本设备，关闭只改变显隐；边缘悬停、Esc 焦点恢复、快捷键与专注模式保持独立。浮层统一登记 pending / visible 遮挡，先等待原生网页隐藏，最后一个浮层退出后才恢复；固定栏只重测布局。

主题入口仅在设置页，显示当前空间名，白 / 暗 / 暖 / 跟随系统按空间保存并同步终端。原生检查发现的旧页面暗色提示条与表头问题已经补齐共享语义颜色。

## 基线、阶段与来源

唯一写入目标为 `bf64`。初始工作树干净，HEAD 仍为 `2466936454658153e47a430ce1da853826f69f69`，没有提交、暂存、推送、合并或发布。导入应用文件在该基线上多为未跟踪文件，不能只用 `git diff --stat` 判断全部实现范围。

| 阶段               | 结果与证据                                                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 旧版基线及来源指纹 | [初始双树指纹](evidence/initial-manifest.json)、[旧版命令](evidence/old-baseline-commands.json)：旧版类型、构建、217 单测、10 项 Electron、8 项 VS001 自检通过。                             |
| 空间运行基础       | [阶段二命令](evidence/stage2-final-commands.json)：按依赖迁移 47 个来源路径，Main/protocol/service 类型、258 单测及资源 MCP wrapper 通过。阶段二尚未迁移 renderer 的类型失败按中间结果保留。 |
| 空间页与消费者     | 六页入口、Main 状态、背景实例、草稿、任务和通知路径进入完整回归；旧测试适配关系见[映射](evidence/test-migration-map.json)。                                                                  |
| 左右栏和主题       | 共享展示模型、独立固定偏好、悬停与焦点、设置主题、原生遮挡、窄窗恢复完成。                                                                                                                   |
| 窗口与审查         | [主线程审查](review.md)、[完整窗口复核](evidence/native-window/README.md)。原始失败和后续修复分别保留。                                                                                      |

[验收合同](SPEC.md)与 `target-baseline.json` 冻结 SR01–SR13 的目标，并不单独证明通过。来源 eb15 的 544 个初始文件、固定 VS001 与历史证据已按原指纹核对，不在其他工作树实施修改；主线程最终[独立指纹核对](evidence/root-final-integrity.json)确认 180 个交付源码文件和命令日志散列吻合，来源与固定基线零差异。

## 自动验证与源码绑定

| 验证范围                                     | 结果                        | 原始证据                                                            |
| -------------------------------------------- | --------------------------- | ------------------------------------------------------------------- |
| 类型、构建、产品 scoped ESLint               | 通过                        | [完整命令索引](evidence/ui-package-final-commands.json)及其日志散列 |
| 单元测试                                     | 295 passed / 8 live skipped | [原始日志](evidence/ui-package-final-unit.txt)                      |
| Electron 全量                                | 45 passed / 4 live skipped  | [原始日志](evidence/ui-package-final-electron-all.txt)              |
| VS001 标准自检                               | 8 passed                    | [原始日志](evidence/ui-package-final-vs001-selftest.txt)            |
| 最后 CSS 修复的类型、构建、scoped lint、格式 | 通过                        | [修复命令索引](evidence/theme-semantic-commands.json)               |
| 最后 CSS 修复的 Electron 外壳与视觉          | 8 passed                    | [原始日志](evidence/theme-semantic-electron.txt)                    |
| 设置三主题 4 类元素对比度                    | 12 项均 ≥ 4.5，最低 5.09    | [实测颜色与比值](evidence/theme-semantic-contrast.json)             |

完整单元 / Electron / VS001 执行源码清单为 `ui-package-final-source-manifest.json`，SHA-256 `07d5b3611cbc63b98591d80cbc509d241bdc15534c1f36925b6e8437890de601`。随后只有 `workspace-debug.spec.ts` 数组换行格式化，清单为 `200ff658241080c786b1fe4c10a81e53090260a3d6273ae3d8cf34ecee705c9b`；该中间状态保留在 `delivery-source-manifest.json`。

最后视觉修复仅修改 `app.css`，当前源码清单为 [theme-semantic-source-manifest.json](evidence/theme-semantic-source-manifest.json)，SHA-256 `7eff9b2af337ee5ef0604b2b55c8b118712bedf1be8e997139fecd4b9bbfa246`。此版本重新构建、类型 / lint / 格式检查，并重跑受影响的 8 项 Electron 与三主题探针；未把旧 45 项结果冒称为新 CSS 版本的全量重跑。

## SR01–SR13 判定依据

| 条件               | 本轮覆盖                                                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SR01 / SR02        | space-remake、workspace-upgrade、workbench 回归；主线程逐页点击和同参考页面完整截图。                                                                                  |
| SR03 / SR04 / SR06 | 状态模型、真实 Electron 悬停与内部焦点、左右键盘、Esc、多层关闭测试；主线程通知浮动 / 固定、左栏整组浮动与焦点复核。                                                   |
| SR05 / SR11        | 独立 pin 持久化、窄窗投影、跨重启与宽窄往返测试；修复前真实失败保留于 `ui-narrow-roundtrip-before.txt`。                                                               |
| SR07               | 统一搜索、已显示标签聚焦、四窗格上限、重开同一后台运行、网页 / 终端实例、草稿和布局恢复均有 Electron 断言；主线程补查中文草稿跨页、长标签与菜单排序。                  |
| SR08 / SR12        | Main 归属单测和 workspace-migration / workbench 原生路径验证：通知定位原空间 / 会话 / 运行、已读独立、任务确认、日志 / diff / 报告可达且查看不执行。联系人仍在会话页。 |
| SR09               | 空间主题持久化、系统映射、实际终端颜色自动断言，三主题对比度探针与主线程窗口截图。                                                                                     |
| SR10               | 原生 WebContents 可见状态、多浮层与 pending 取消、布局 bounds、固定栏触发区断言，加完整系统窗口观察。                                                                  |
| SR13               | Main 单点状态权威与旧接口静态审查、旧快照额外 sidebarMode 字段恢复测试、来源与 VS001 指纹。                                                                            |

## 限制与已知结果

- 全树 lint 仍有固定 VS001 `tests/vertical-slice/cdp.ts:16 prefer-const` 历史问题，原文保留，未修改固定基线；不能宣称 `pnpm check` 全绿。
- 8 项单测与 4 项 Electron live 场景明确跳过，未调用真实模型或 sandbox live。fixture、独立检查器未接入提示与业务接受结果分别判定；本轮未扩展业务 API 或未实现的适配器。
- 未执行打包或打包产物回归。“ui-package”证据文件名指本轮实施工作包，不代表已打包、签名或发布。
- 菜单排序已在原生窗口确认；拖拽尝试没有得到可确认结果，拖拽手势单独保持 `undetermined`。
- 中文 composition/键盘程序事件及原生粘贴草稿通过，不代表真实 macOS 中文输入法候选窗通过；后者为 `undetermined`。
- 最初 pnpm11 自动安装因非 TTY 失败，后续使用本机缓存 pnpm10.34.6 与已有依赖，未安装升级。受限环境启动失败和三主题探针自身 `__name` 错误均保留，获准原生执行 / 修正探针后才记录实际通过。
