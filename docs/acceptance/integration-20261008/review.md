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
| F09 | 远程文件图片结果误标 disk，文本结果正确标 sftp | Phase2a 已补来源修复及负例，待本段终审 |
| F10 | LocalTerminal helper 未确认清理后 child=null，及 SSH 断线后 shell=null，close/shutdown 仍可返回成功，令未知进程被当作已关闭 | 主线程 Phase2a 差异审查发现，退回 coder 补失败证据和修复 |
| F11 | sandbox Terminal 输出截断未增加 outputOffset；超过 262144 字符后 renderer 不能判断新窗口偏移 | 待同一 PTY 连续输出回归与 Phase3 消费者接线 |

## 全量静态覆盖

来源审查的 2974 条文件台账见 [sources/file-ledger.json](sources/file-ledger.json)；这是来源差异裁决，不代表 2974 个独立产品文件。Renderer、非 live 测试、配置与固定展示内容的 138 文件正文审查见 [sources/review-renderer.md](sources/review-renderer.md)。

主线程另行读取 Main 工作台 application/host/repository/ports/layout、启动与关闭、IPC/来源校验/preload/菜单、PreviewController 和公开文档代理、所有既有协议，以及 service 的 Codex/PTY/sbx/资源存储、guest 浏览器与 Python MCP。重点核对单一状态归属、持久化与失败回滚、跨空间代次、取消/清理确认、网络与文件边界；新代码按各阶段 manifest 补评，不能沿用基准结论。

现有 live 测试正文已逐项核对：真实对话两轮及 reset；sandbox 前台/后台进程、EOF 与 PID 清理；资源 nonce 不进入 prompt、要求实际 MCP 调用和精确内容；guest 浏览器 DOM/PNG 摘要与 sealed memfd 负例；空间运行及 PTY 跨页/跨空间实例保持。发现 guest-browser live 证据路径写死在旧目录、sbx UI live 未清理本轮 guestDir，交后续测试工作包修复。正文审查不构成 live 已执行通过。
