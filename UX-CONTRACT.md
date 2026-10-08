# 工作台交互契约

本轮导航与布局依据 [SR-1](docs/acceptance/space-remake/SPEC.md)。业务来源为 `docs/verification/2026-10-06-sbx-app/SPEC.md`、公开资源合同和 `packages/protocol/src/{workspace,chat,terminal,resources}.ts`。历史原型保持原意；此合同定义目标行为；空间重制历史见[SR-1记录](docs/acceptance/space-remake/task-summary.md)，本轮接线与实测见[INTEGRATION-1记录](docs/acceptance/integration-20261008/task-summary.md)。

## Canonical UI Map

| Capability       | Canonical owner                  | Source of truth                                 | Allowed variants                     | Verification                        |
| ---------------- | -------------------------------- | ----------------------------------------------- | ------------------------------------ | ----------------------------------- |
| Scrollbar        | app.css 全局样式                 | app.css 运行时 token                            | xterm viewport 保持内部几何          | 窄窗与终端 E2E                      |
| Form             | Composer / Session               | 个人 drafts / Main 空间会话                     | 个人/空间会话                        | chat E2E 的 IME、草稿保留与重复提交 |
| CRUD             | Main workbench / ResourcesPage   | public-resources SPEC 与 resources protocol     | 工具栏保存留在页面 / 资源页更新移除  | resources UI E2E                    |
| Toast            | Notice / ErrorToasts             | Main 业务错误与 shell 偏好错误                  | 全局错误 / 资源行内状态              | 失败恢复 E2E                        |
| Dialog           | ModalLayer                       | app-owned dialog 与资源生命周期合同             | 图像查看 / 资源移除                  | Escape / focus / 移除 E2E           |
| Navigation       | App / Workshop / SpacePage       | shell 展示状态、Main 空间快照                   | 全局按钮、空间垂直标签、固定/浮层    | 六页导航、切换、重启和窄窗          |
| Notification     | RightPanel / Notifications       | Main 运行终态与持久阅读回执                     | 真实通知 / 标记的历史演示            | 定位不执行、不接受、不自动已读      |
| Select/Listbox   | native select                    | Main theme、已配置环境及会话观察源              | 接受系统弹出层；不自建第二套listbox  | 主题、环境选择与键盘测试            |
| Resource context | Main observation / Session上下文 | 冻结workspace/session/run/resource/instance身份 | 主动观察、结果与失效提示；右栏不承载 | 多空间、取消/迟到、真实UI           |
| File reader      | 空间文件标签                     | Main资源与显式授权环境的只读Provider            | 本地/SSH目录、正文、续读             | 越界/符号链接、hash/续读失效、窄窗  |

## 状态与导航

全局保留首页、空间、资源、会话、任务和底部设置。空间切换器、垂直标签、最多四窗格只属于空间页；没有“空间标签/工作坊”二级导航或顶部重复标签。首页、资源、任务和通知直接读取 Main 快照，shell 只拥有全局路由、侧栏和临时展示状态。个人对话保留原窄 chat 客户端；空间会话和任务不再使用旧演示 store。

左右栏拥有独立的 `pinned / hidden / peek`，仅 `pinned` 保存到本设备。首次左栏固定、通知未固定且收起。左图钉控制按钮列和空间标签整组；关闭不改固定偏好，取消固定收起，窄窗不改持久偏好。⌘B只控制左栏，⌥⌘B只控制通知，专注模式独立。左栏边缘悬停160ms展开、离开300ms收起，焦点仍在面板内不收起；Esc关闭临时浮层并恢复触发器焦点。

空间名称只打开切换器。搜索不改变当前空间，点击结果才定位；清除搜索立即生效并返回搜索焦点。方向键、Home/End移动标签焦点，Enter打开；拖动排序有按钮等价操作。点击已显示标签聚焦原窗格，关闭窗格或标签不停止后台实例。明确关闭实例才结束其进程；后台资源可重开同一资源。

切标签/页面不结束 shell、重播输入或清空输出；隐藏终端不抢焦点，重新激活后获取输入焦点。主题只在设置页编辑，标明当前空间；白/暗/暖/系统按空间保存。空间的旧 `sidebarMode` 被整组 shell 偏好替代，不保留第二个固定入口。

多种浮层使用统一遮挡集合。打开前等待 Main 隐藏原生网页，再发布可点击浮层；最后一个浮层关闭后恢复。固定左右栏只触发实际矩形重测，不作为遮挡；边缘气泡不能被原生网页覆盖。1080px以下仅投影活动窗格，原分割树和后台实例不变，放宽恢复。

终端入口显式连接，starting/closing 禁用重复操作；仅 running 接收键盘和 resize。Ctrl-C 可通过键盘或可见按钮输入。关闭等待所属进程清理确认后显示已关闭；失败保持输出并展示错误，不能暗示成功。退出 shell 会关闭会话；再次连接创建新的 shell，不继承旧 cwd。

服务序号决定输出新旧；迟到查询与旧会话事件不能覆盖最新快照。服务保存有界尾部，outputOffset 与字符串采用同一 UTF-16 字符计数。界面按实例、PTY会话和绝对区间追加新尾段；重复文本但偏移增加仍是新输出。裁剪后存在重叠时保持终端状态，未读区间已丢失或实例更换时重建并明确提示缺口。

chat 在首页、会话页和空间会话标签显示相同 sandbox/cwd 来源；工具命令、输出、退出码和截断标记按需展开，非致命配置 warning 显示文字。服务不可用时保留输入、拒绝发送，不回退宿主 Codex。

通知只读展示运行事实，并定位准确的空间、会话和run。打开不自动已读，已读只保存阅读回执，不改变执行、检查或接受。任务历史、日志、diff和报告按指定运行展示；选择历史版本同步选择该版本的运行，若尚无运行则显示空态，不能回退到最新会话消息、工具或错误。没有证据明确说明，不能填入演示成功。现场采集通过网页关联会话入口到达，requestId冻结接收方，迟到结果不能污染其他请求。联系人位于会话板块。

窄窗口保持现有侧栏和布局 token；终端尺寸由可见内容区域计算。输入具有中文可访问名称，连接/关闭状态用 status，失败用 alert。真实 live 验证显式启用，fixture 输出不作为真实 Linux 或模型证据。

## 公开网页资源（2026-10-06）

业务来源：`docs/verification/2026-10-06-public-resources/SPEC.md` 与 `packages/protocol/src/resources.ts`，资源权限与保留规则以后者及服务为准。

- CRUD：公开资源服务为事实权威，通过 Main workbench 命令与快照访问。工具栏保存留在页面，提供“查看空间资源”；列表显示全部至多 16 条，没有隐式分页。选择仅属于当前页面，不显示其他空间内容。
- Toast / 状态：沿用 `Notice / ErrorToasts`；资源操作在 Main `publicResourcesError` 投影中保留行内错误、重试与 status，不用瞬时提示承载关键结果。
- Dialog：`ModalLayer` 统一使用 app-owned `dialog.showModal()`，背景 inert、Tab 范围、Escape 与关闭后的焦点恢复由原生 dialog 承载。移除先聚焦取消，显示资源名、空间及既有副本不能撤回的后果；失败保持对话框并可取消或重试。
- Form：地址栏显式 noValidate，中文 IME 确认不提交；资源不接受用户自报正文。只读文档标签说明真实网页正文提取，不暗示完整原站交互。
- 生命周期：保存、更新和移除等待服务响应；同空间重复提交禁止，旧列表响应不能覆盖新集合版本。空间任务运行/清理中提前禁用变更，服务仍执行权威检查。
- 更新：仅当前成功页面 URL 匹配所选资源时可用，main 再核验完整页面身份。移除后焦点回资源标题，下一轮读取新集合；不宣称删除已有对话或 Agent 留存副本。
- 滚动：资源列表与详情沿用管理页内容滚动；正文换行，完整 URL / UUID / SHA-256 可见，窄窗不隐藏详情或动作。
- 页面来源：依据 `packages/protocol/src/resources.ts` 的 `extractionVersion` 区分身份。`html-text-v1` 保留 webContents 与文档代次；`rendered-dom-text-v1` 明示“沙箱浏览器”、沙箱名、页面 targetId 与导航代次，不套用宿主页面身份或显示运行时文件路径。
- 验证：`main/workbench/public-resources-migration.test.ts`、`state/workspace.test.ts` 和 `e2e/resources.spec.ts` 覆盖应用、投影与交互；`e2e/resources-live.spec.ts` 必须显式授权运行，校验真实网络与 MCP 工具调用，fixture 不能替代。

## 统一观察与资源环境（INTEGRATION-1）

- 新建文件或终端时明确选择已配置环境；显示环境名称及可用能力。未配置本地根或SSH配置时给出不可用原因，不使用home、不复制认证，也不从终端输入推导授权。资源创建后绑定当前空间与环境，切空间不能把已有资源重新归属。
- 文件标签仅浏览授权根内的目录和读取内容，不提供编辑/保存。路径、内容来源、范围、散列和截断可见；续读使用已有游标，内容变化时显示失效并要求重新读取。watch提示“可能变化”，不能用无提示表示内容未变。SFTP没有watch时明确说明。
- 终端资源使用本地、sandbox或SSH之一；UI与观察读取同一实际PTY。连接/关闭/重连为明确动作，关闭标签保留实例；重启只恢复资源描述，不自动执行shell。SSH断线后的远端进程状态不明时显示未确认，重连明确拒绝，不能宣称已清理。连接尚未取得终端适配器就失败时，服务明确证明未创建进程，允许用户重试；错误文字本身不能充当清理证明。
- 会话的上下文区域提供观察入口，选择本空间实际资源及适合该类型的读取动作，显示来源、范围、结果、时间及更新提示。观察成功不自动发送消息、启动任务、标记通知已读或接受结果；结果归属请求开始时的空间、会话和运行。
- 读取期间给出忙态和取消入口，重复提交受限；取消、切空间、替换实例后的迟到结果不能覆盖新的上下文。取消保留之前已完成的证据；证据只追加，不覆写。失败保持用户输入和可重试状态，明确区分无权限、不可用、过期与截断。
- 复用现有按钮、行内状态、原生select、ModalLayer与原生网页遮挡集合。文件读取和观察不新增全局板块、右侧会话、空间主题入口或悬浮终端。新增表单使用noValidate、中文标签和IME安全提交；搜索有可见清除按钮，长资源名/路径能换行或完整查看。
- 旧公开网页快照合同仅为TaskFlow demo空间提供资源MCP，其他空间不能继承该集合。统一观察按Main注册的空间与环境授权，独立于该历史限定，不把旧demo集合当作全空间观察源。
