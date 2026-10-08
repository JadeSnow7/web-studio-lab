# 主线程审查记录

基准为 9e1df45；下述发现与阶段验收分开，未解决项不能作为通过。

| ID | 发现与证据 | 状态 |
| --- | --- | --- |
| F01 | Electron全量44通过/1失败；窄窗900×700，原生网页与DOM容器width差196。相同workbench文件重跑9通过/1同失败。原文 evidence/baseline/electron-unsandboxed.json、workbench-repeat.json | 已确认测试时序：4轮原生探针34–46ms内全部bounds收敛；待改为条件轮询 |
| F02 | 候选router固定taskflow-demo、Browser webcontents:N、Terminal sessionId、File source/read/watch身份不同，不能用于多空间 | Phase1/2适配 |
| F03 | 候选Browser监听没有dispose；需释放事件和拒绝关闭后迟到结果 | Phase1已修复并验证 |
| F04 | 当前ARCHITECTURE仍有“未落地应用源码”、已退役state/runs路径、任务权威定位与实际Main不符；远端606参赛材料也绑定仅VS001的旧main | 最后按最终源码同步当前文档，保留历史事实 |
| F05 | 全树lint固定VS001 cdp.ts prefer-const；format失败包含封存证据、VS001及当前文档。不能通过自动改写证据制造通过 | 已分类，最终仍独立报告全树结果 |

主线程已亲读基准检查的原始命令、退出码、stdout/stderr，以及Main application/host/repository/IPC/preload/窗口/菜单、native PreviewController/公开文档代理、service进程/chat/PTY/资源存储、协议及候选核心Provider。完整逐文件覆盖汇总随最终源码补齐，不将文件清单当作已审查。

## Phase1 审查结论

主线程逐行阅读16项源码、测试与依赖差异，检查稳定资源身份、取消/关闭后的迟到结果、文件root descriptor与符号链接边界、watch释放、VT游标/缺口、SSH host pin与SFTP预算。审查补入Terminal dispose后拒绝resize与晚输出。原始负例5失败证明旧候选不满足当前契约；最终typecheck、全量unit（341通过/8 live跳过）、定向lint/format与build均通过且执行期间revision不变。证据与源码SHA见[evidence/phase1-source-manifest.json](evidence/phase1-source-manifest.json)。此阶段Provider尚未接入产品界面，不能作为集成验收通过。

| ID | 后续发现 | 状态 |
| --- | --- | --- |
| F06 | Sidebar自落点拖拽先删除自身后indexOf=-1，真实窗口中首标签移位；sources/sidebar-selfdrop-probe.json | 待Phase3修复 |
| F07 | Session选择v2后selectedRunId仍指v1，任务正文与运行日志错配；sources/history-version-probe.json | 待Phase3修复 |
| F08 | VS001 verifyManifest 只在 B05 passed 分支重评观察证据；单独 B03 passed 且无 identity/observation/CDP 的合成负例仍被接受；sources/vs001-verifier-probe.json | 待独立修复复核器，固定目标、fixture、postcondition 与历史指纹不变；新方法版本单独记录 |
| F09 | 远程文件图片结果误标 disk，文本结果正确标 sftp | Phase2a 已修复，负例与最终回归通过 |
| F10 | LocalTerminal helper 未确认清理后 child=null，及 SSH 断线后 shell=null，close/shutdown 仍可返回成功，令未知进程被当作已关闭 | Phase2a 已修复；启动前、启动中及关闭中断线均保留 unknown，失败及复验原文保留 |
| F11 | sandbox Terminal 输出截断未增加 outputOffset；超过 262144 字符后 renderer 不能判断新窗口偏移 | Phase2a 同一 PTY 连续输出回归通过；Phase3 消费者接线待完成 |

## 全量静态覆盖

来源审查的 2974 条文件台账见 [sources/file-ledger.json](sources/file-ledger.json)；这是来源差异裁决，不代表 2974 个独立产品文件。Renderer、非 live 测试、配置与固定展示内容的 138 文件正文审查见 [sources/review-renderer.md](sources/review-renderer.md)。

主线程另行读取 Main 工作台 application/host/repository/ports/layout、启动与关闭、IPC/来源校验/preload/菜单、PreviewController 和公开文档代理、所有既有协议，以及 service 的 Codex/PTY/sbx/资源存储、guest 浏览器与 Python MCP。重点核对单一状态归属、持久化与失败回滚、跨空间代次、取消/清理确认、网络与文件边界；新代码按各阶段 manifest 补评，不能沿用基准结论。

现有 live 测试正文已逐项核对：真实对话两轮及 reset；sandbox 前台/后台进程、EOF 与 PID 清理；资源 nonce 不进入 prompt、要求实际 MCP 调用和精确内容；guest 浏览器 DOM/PNG 摘要与 sealed memfd 负例；空间运行及 PTY 跨页/跨空间实例保持。发现 guest-browser live 证据路径写死在旧目录、sbx UI live 未清理本轮 guestDir，交后续测试工作包修复。正文审查不构成 live 已执行通过。

## Phase2a 审查结论

主线程审查 26 个源码及测试文件，并核对最终 manifest 的全部 SHA256 与当前字节一致。最终 typecheck、build、改动文件 lint/format 与全量 unit（367 passed、8 live skipped）均通过；各回执执行期间 revision 稳定。原文为 `evidence/phase2a-final-*.json`。此结论只覆盖环境及服务适配，Main 与 MCP 接线尚未完成。

| ID | 发现与证据 | 修复与复验 |
| --- | --- | --- |
| F12 | 原 local helper 仅按原进程组清理；脱离后代仍活着时曾回报成功。`phase2a-detached-process-before.json` 的进程探针退出码 0 仅代表探针执行完毕，`owned_detached_child_alive=true` 才是该场景失败依据 | 按本轮随机继承标记、用户及进程出生身份识别后代，发信号前再次核对；不可核实时保留 unknown。相同探针最终 cleanup=true 且 child_alive=false。另测出生身份改变和标记不可读时不发信号；未声称实际制造 PID 重用 |
| F13 | 中文输入按字符数通过 TypeScript 边界后，UTF-8 字节超出 helper 预算，导致 PTY 异常退出 | 边界改为 UTF-8 字节预算；超额输入拒绝后，同一 PTY 仍可执行下一条命令。before 失败原文保留，最终回归通过 |

本地终端以当前用户权限运行，指定目录只是起始目录；文件观察的授权根是读取边界。这不是操作系统沙箱，也不保证清除主动移除继承标记的恶意进程。

基准 `9e1df45` 的 apps/packages/scripts/e2e/tests/fixtures 共 169 个执行源码文件：原 138 文件表映射其中 119 个；主线程补读 45 个，其余 5 个（service 与 e2e 的 Codex/sbx fixture、raw.d.ts、service Vite 配置）由独立审查补齐。没有剩余未读执行源码。fixture 的进程和清理回执是确定性模拟，不能作为 live 清理证据；新增代码仍按阶段独立审查。
