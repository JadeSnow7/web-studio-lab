# 沙箱对话与终端交互契约

业务来源：`docs/verification/2026-10-06-sbx-app/SPEC.md` 与 `packages/protocol/src/{chat,terminal}.ts`。这里只记录本轮 UI 后果，历史原型保持原意。

## Canonical UI Map

| Capability | Canonical owner                         | Source of truth                             | Allowed variants                    | Verification                        |
| ---------- | --------------------------------------- | ------------------------------------------- | ----------------------------------- | ----------------------------------- |
| Scrollbar  | app.css 全局样式                        | app.css 运行时 token                        | xterm viewport 保持内部几何         | 窄窗与终端 E2E                      |
| Form       | Composer                                | chat protocol 与既有 drafts store           | 个人/空间会话                       | chat E2E 的 IME、草稿保留与重复提交 |
| CRUD       | resourcesStore / resourceActions        | public-resources SPEC 与 resources protocol | 工具栏保存留在页面 / 资源页更新移除 | resources UI E2E                    |
| Toast      | Notice / ErrorToasts / ResourceFeedback | 既有反馈与资源状态                          | 全局错误 / 资源行内状态             | resources 失败恢复 E2E              |
| Dialog     | ModalLayer                              | app-owned dialog 与资源生命周期合同         | 图像查看 / 资源移除                 | Escape / focus / 移除 E2E           |

## 状态与导航

空间标签沿用 TitleBar 和 shellStore；方向键、Home/End 移动选中标签。终端与 Preview 共用空间，终端激活时原生预览隐藏。切标签/页面不结束 shell、重播输入或清空输出；隐藏终端不抢焦点，重新激活后获取输入焦点。

终端入口显式连接，starting/closing 禁用重复操作；仅 running 接收键盘和 resize。Ctrl-C 可通过键盘或可见按钮输入。关闭等待远端 cleanup 确认后显示已关闭；失败保持输出并展示错误，不能暗示成功。退出 shell 会关闭会话；再次连接创建新的 shell，不继承旧 cwd。

服务序号决定输出新旧；迟到查询与旧会话事件不能覆盖最新快照。服务只保存尾部 256 Ki 字符，界面明确该范围；截断后 xterm 重建当前快照，避免把重复尾部当新输出。

chat 在首页、通信栏和会话页显示同一 sandbox/cwd 来源；工具命令、输出、退出码和截断标记按需展开，非致命配置 warning 显示文字。服务不可用时保留输入、拒绝发送，不回退宿主 Codex。

窄窗口保持现有侧栏和布局 token；终端尺寸由可见内容区域计算。输入具有中文可访问名称，连接/关闭状态用 status，失败用 alert。真实 live 验证显式启用，fixture 输出不作为真实 Linux 或模型证据。

## 公开网页资源（2026-10-06）

业务来源：`docs/verification/2026-10-06-public-resources/SPEC.md` 与 `packages/protocol/src/resources.ts`，资源权限与保留规则以后者及服务为准。

- CRUD：`resourcesStore / resourceActions` 是列表、保存和移除反馈的共同 owner。工具栏保存留在页面，提供“查看空间资源”；列表显示全部至多 16 条，没有隐式分页。选择仅属于当前页面，切换个人作用域不显示旧空间内容。
- Toast / 状态：沿用 `Notice / ErrorToasts`；资源操作用共享 `ResourceFeedback` 保留行内错误、重试与 status，不用瞬时提示承载关键结果。
- Dialog：`ModalLayer` 统一使用 app-owned `dialog.showModal()`，背景 inert、Tab 范围、Escape 与关闭后的焦点恢复由原生 dialog 承载。移除先聚焦取消，显示资源名、空间及既有副本不能撤回的后果；失败保持对话框并可取消或重试。
- Form：地址栏显式 noValidate，中文 IME 确认不提交；资源不接受用户自报正文。只读文档标签说明真实网页正文提取，不暗示完整原站交互。
- 生命周期：保存、更新和移除等待服务响应；同空间重复提交禁止，旧列表响应不能覆盖新集合版本。空间任务运行/清理中提前禁用变更，服务仍执行权威检查。
- 更新：仅当前成功页面 URL 匹配所选资源时可用，main 再核验完整页面身份。移除后焦点回资源标题，下一轮读取新集合；不宣称删除已有对话或 Agent 留存副本。
- 滚动：资源列表与详情沿用管理页内容滚动；正文换行，完整 URL / UUID / SHA-256 可见，窄窗不隐藏详情或动作。
- 页面来源：依据 `packages/protocol/src/resources.ts` 的 `extractionVersion` 区分身份。`html-text-v1` 保留 webContents 与文档代次；`rendered-dom-text-v1` 明示“沙箱浏览器”、沙箱名、页面 targetId 与导航代次，不套用宿主页面身份或显示运行时文件路径。
- 验证：`state/resources.test.ts`、`e2e/resources.spec.ts` 是 fixture 状态与交互证据；`e2e/resources-live.spec.ts` 必须显式授权运行，校验真实网络与 MCP 工具调用，fixture 不能替代。
