# 最终源码验收与交付

整合实现已落地并形成追加本地提交；整体产品验收为 **undetermined**。已通过的自动化和 live 场景不覆盖被锁屏阻塞的原生输入，也不替代失败的 guest 网络采集、尚未实现的独立检查器或未知来源字节。

## 交付范围

独立基准为 `9e1df45`，当前分支为 `codex/space-remake-integration-20261008`。追加工作包依次为 `331c47f`（观察协议/Provider）、`fc71b55`（来源冻结）、`c97b673`（本地/SSH）、`d9beb8a`（Main/MCP/迁移）、`612cde0`（空间界面）、`46cab72`（验证工具与导出）、`965ebcd`（原生导航竞态）、`247247b`（SSH重试与产品回环）、`5d9542e`（观察live与根撤销回归）。本文件所在的最后追加提交保存F29修复、最终测试适配和验收记录，不改写基准。未推送、合并 main、发布或正式提交参赛材料。

保留六页直接入口、空间切换/垂直标签/四窗格、通知气泡和设置主题。Browser、文件与终端观察统一由 Main 冻结空间、会话、运行、环境及实例归属；本地文件只读授权根，终端可选已配置的本地、sandbox、SSH 环境。SSH/SFTP 沿用可信配置和主机 pin，空间快照不保存认证或重放进程。右栏仍只显示通知。

[来源裁决](../../integration-disposition.md)与[冻结台账](../../sources/file-ledger.json)保留每项来源差异：16 树中15树完成实际文件冻结，第16树49个dirty候选稳定，324个非dirty文件实际字节未知，未从未知字节迁入。2974条是跨来源记录，不是独立文件数。旧 renderer 权威、旧工作坊外壳、固定 TaskFlow/匿名PTY接线和旧聊天上下文未采纳；过期 premium-audit.json 保留在工作树且不提交。

## 审查与缺陷

[执行代码覆盖](source-coverage.json)有205条逐路径索引，包含26个索引缺失文件的补充正文审查；[其他文件](source-coverage-addendum.json)覆盖样式、HTML、配置、锁文件和导出器。[最终测试差异复核](final-test-diff-review.json)、[F29最终清单](observation-receipt-gate-manifest-v2.json)及[资源初始化复核](resource-initialization-root-review.json)追加变更指纹；[交付清单](delivery-source-manifest.json)的232个文件已逐一与最终磁盘字节核对。历史索引不改写。各阶段源码、失败及复验清单由[阶段审查](../../review.md)链接，源码阅读不等同于运行验收。

已修复的主要问题包括：跨空间/实例迟到结果与取消归并、不可变证据和运行预算；文件授权根变更、越界/符号链接/续读及watch释放；本地脱离进程清理与SSH清理未知状态；UTF-8输入和MCP帧预算；原生导航旧请求中断新请求；SSH主机pin拒绝后无法重试；空间标签自拖、任务历史错配、终端能力状态不刷新；VS001复核器独立门槛；F29大型MCP结果摘要丢失观察身份，现按协议保留身份并明确省略范围，原始失败及阶段复核见[F29](F29-final-root-review.json)，该阶段记录中等待live的状态由[最终原始证据复核](delivery-live-root-review.json)和[统一观察live复核](frozen-observation-root-review.json)更新，保留旧记录原文。测试适配另外修复空PID文件竞态、旧UI/提示符假设、packaged异常采集及观察测试收尾错误，未删除产品断言。

## 最终复验

最终源码清单、完整命令（含启用live的环境参数）、原始回执与状态由[最终索引](final-index.json)汇总。不同修订的早期失败及中间通过全部保留；只有在来源指纹匹配的范围内引用旧结果。

| 检查                       | 最终结果                              | 原始回执与限定                                                                                                                                                           |
| -------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 全量单元                   | 426通过、8跳过                        | [unit](delivery-unit.json)；live另行显式启用                                                                                                                             |
| 类型、依赖边界、文档、构建 | 通过                                  | [类型](delivery-type.json)、[边界](delivery-boundaries.json)、[文档](delivery-docs.json)、[构建](delivery-build.json)；文档检查为本地链接目标与尾随空白，不包含外链/锚点 |
| 当前产品lint与格式         | 通过                                  | [lint](delivery-lint-active.json)、[格式](delivery-format-active.json)                                                                                                   |
| 全树lint                   | failed，217错误                       | [原文](delivery-lint-full.json)：126归档配置解析、90归档诊断规则、1固定VS001问题                                                                                         |
| 全树格式                   | failed，672文件                       | [原文](delivery-format-full.json)及[逐项分类](delivery-full-check-classification.json)；计数对应执行时点，后续追加元数据不回写原文                                       |
| Electron构建版             | 55通过、5跳过                         | [回执](delivery-electron-build.json)及[产物](delivery-electron-build-artifacts/manifest.json)                                                                            |
| Electron本地包             | 53通过、7跳过                         | [回执](delivery-electron-packaged.json)及[产物](delivery-electron-packaged-artifacts/manifest.json)                                                                      |
| VS001                      | 自检12通过，业务基线5项target_missing | [自检](delivery-vs001-selftest.json)、[基线](delivery-vs001-baseline.json)；performed=false不算业务执行通过                                                              |
| 导出与视觉静态检查         | 导出器2通过；静态0发现                | [导出器](delivery-exporter-test.json)、[静态](delivery-premium-static.json)；九页PDF见[逐页复核](pdf/review.json)                                                        |
| 本地打包                   | 未签名构建通过                        | [命令](frozen-package.json)、[包hash](frozen-package-artifacts.json)、[源码对应关系](delivery-package-affinity.json)；最后改动仅live测试等待逻辑，未进入包运行源码       |
| 显式live                   | 12通过、1失败                         | 下列串行live回执；失败为guest浏览器目标导航；不重复累计其他轮次                                                                                                          |
| 验收记录结构               | 通过，整体验收仍undetermined          | [结构校验](delivery-record-validation-v2.json)；历史提交缺少独立授权快照的警告保留；[首次登记修正](record-binding-correction.json)说明未改写Spec或原始回执               |
| 原生窗口                   | undetermined                          | [实际尝试](native-final-attempt.json)；真实拖拽、IME候选窗及系统合成层点击穿透not_run                                                                                    |

构建版5个跳过项为独立live套件；打包版另外跳过仅由build bootstrap支持的启动前故障注入和可控环境延迟场景。运行期异常负控在两种目标均执行。截图[视觉复核](delivery-visual-review.json)确认六页外壳、两侧气泡、暖色三窗格及独立网页内容；窗口截屏未包含WebContentsView像素，不能据此宣称原生合成层通过。

## 验收矩阵

| 条件             | 结果与边界                                                                              |
| ---------------- | --------------------------------------------------------------------------------------- |
| INT-01 来源冻结  | partial：15树实际字节完整；第16树324文件未知，不采纳未知字节                            |
| INT-02 六页/空间 | 自动回归见上表；真实拖拽及系统焦点undetermined                                          |
| INT-03 Main归属  | 单元、真实运行切空间及统一观察的结果分别记录；不引入第二状态源                          |
| INT-04 实际观察  | WebContents、本地授权文件、同一PTY具备单元/产品路径；guest网络采集失败另列              |
| INT-05 文件边界  | 授权根撤销、越界/符号链接、内容hash/续读、watch释放回归通过                             |
| INT-06 环境/SSH  | 本地与sandbox验证、真实回环SSH/SFTP和pin拒绝通过；外部主机not_run                       |
| INT-07 MCP       | 多空间、冻结身份、失效、取消/迟到、归档和预算自动回归；三来源live另列                   |
| INT-08 迁移恢复  | 旧ID/布局保留、占位无授权、凭据/句柄排除、重启不重放自动回归通过                        |
| INT-09 源码/文档 | 205执行路径审查索引（其中26项补读正文）及各阶段与最终差异；其他文件清单；来源未知仍保留 |
| INT-10 离线检查  | passed/failed按上表独立列出；全树lint/格式与VS001目标缺失没有改写为成功                 |
| INT-11 live      | 模型/PTY/资源/运行通过；统一观察见专项；guest捕获undetermined                           |
| INT-12 原生界面  | undetermined：原生工具绑定时锁屏；真实拖拽与中文候选窗not_run，自动化R3另列             |

上述结果不支持“全部通过”。封存失败、不可核对来源和环境阻塞仍是有效边界。

## Live与环境边界

串行复用 `wsl-sbx-smoke-20261006`，前置核验身份、工具、镜像及认证状态，仅使用独立profile、目录和随机标记。API-key登录指示是当前guest状态，不推断上游代理凭据；没有读取/复制认证内容或重置sandbox。

- `frozen-live-service-sbx.json`与`frozen-live-mcp-agent.json`：六个真实服务场景及一个模型资源场景通过，覆盖PTY尺寸/cwd/CtrlC、后台和脱离进程、取消及EOF清理。
- `frozen-live-mcp-agent.json`：真实模型通过资源MCP读取受控nonce；此项不等于实际网页采集。
- `frozen-live-chat.json`：三轮实际模型对话、上下文保持及新会话隔离。
- `final-live-resources.json`及[最终原始输出复核](delivery-live-root-review.json)：实际网页采集后，模型读取相同资源ID、版本与内容散列；移除后列表为空。
- `frozen-live-sbx-ui.json`及[最终复核](delivery-live-root-review.json)：终端创建本轮文件，实际模型在同一sandbox读取未知nonce；包含窄窗切页、终端保活、CtrlC及清理。
- `frozen-live-workspace.json`及[最终复核](delivery-live-root-review.json)：真实模型运行留在原空间/会话，切换及重开不替换PTY，最终终端和对话均无待清理。独立检查仍blocked、审阅为空、通知未自动已读。
- 统一观察live：`frozen-live-observation.json`通过，四个真实MCP调用的完整结果或有界元数据与Main记录相等；原空间运行中切换、另一空间隔离、三未知nonce和进程/应用清理均通过，见[独立原始输出复核](frozen-observation-root-review.json)。
- `delivery-live-guest-browser.json`最终复跑仍失败。实际Chromium开启sandbox，Fetch在策略回调前已收到network failure，随后按策略终止并确认browserClosed；[只读诊断](guest-network-review.json)对固定目标得到HTTP403。不能仅凭403区分目标站和网关责任；未降低TLS、sandbox或网络策略。成功guest DOM/PNG/MCP仍undetermined。

回环SSH/SFTP使用临时服务器、真实agent签名及host-key拒绝，产品测试包含正确配置、两次PTY关闭、文件读取、错误pin重试和断线。未建立外部主机连接，不能宣称生产远端通过；断线未知状态下的受控强退不算正常shutdown成功。

[最终原生尝试](native-final-attempt.json)记录桌面曾短暂可枚举，但绑定本轮窗口时再次返回锁屏错误。已正常关闭独立测试应用并确认清理；没有用程序事件冒充真实拖拽或中文候选窗。R3系统焦点历史失败保留，最新自动化结果以上表为准。packaged启动前故障注入及可控环境延迟依赖build bootstrap，因此明确not_run；两种目标的运行期异常负控仍实际执行。

## 历史与产物

[历史字节检查](delivery-sealed-history-check.json)保护固定VS001目标/断言与先前验收目录；复核器改动采用新方法指纹。VS001 B01–B05因目标适配器缺失保持target_missing/performed=false，自检通过不代表业务链路通过。全树lint和格式失败单列，未格式化封存源、删除断言或追加ignore来制造全绿。

未签名本地包位于 `apps/desktop/release/`，构建参数明确 `--publish never`，包指纹见最终索引。九页参赛草稿[导出复核](pdf/review.json)包含PNG、中文字体和链接检查；是本地材料检查，不是产品验收或对外提交。构建产物、依赖和运行数据不进入Git；原始失败、截图、命令和源码指纹随本次追加提交保存。
