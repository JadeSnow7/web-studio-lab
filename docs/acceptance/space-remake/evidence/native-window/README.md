# SR-1 原生窗口复核

主线程使用 CUA 操作真实 Electron 窗口，截图为 macOS 合成窗口，不是 renderer 与 WebContents 的分图拼接。左上紫色标记是系统屏幕采集提示。应用由当前本地构建启动，使用临时 profile、仓库 sbx fixture 和无效宿主 Codex 路径；没有真实模型或外网运行。

启动参数见 [manual-launch.json](../manual-launch.json)。该文件的 `not_started` 是启动前记录；实际执行与结果由本记录及截图说明。首次检查对应完整回归后的构建；发现主题问题后，已用同一 profile 重启最终 `7eff9b2a…` 构建复检。两次隔离实例均通过 ⌘Q 正常退出。

## 已观察事实

| 截图                                                           | 操作与结果                                                                                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [01-reference-layout.png](01-reference-layout.png)             | TaskFlow“完善首页”与用户参考图同一页面。全局五个主按钮和底部设置可见，空间内垂直标签，无顶部重复水平标签。                       |
| [02-notification-bubble.png](02-notification-bubble.png)       | 点击 0 未读通知气泡，仅展开圆角浮层，图钉未选中；原生网页隐藏后显示占位。                                                        |
| [03-notification-docked.png](03-notification-docked.png)       | 点击固定通知，通知占据右侧布局，原生页面恢复并按剩余矩形重排；取消固定后收起。                                                   |
| [04-left-group-floating.png](04-left-group-floating.png)       | ⌘B 关闭固定左栏后点击边缘把手，按钮列与空间标签整组浮动；Esc 收起，焦点回到左边缘触发器；再按 ⌘B 恢复固定布局。                  |
| [05-settings-dark.png](05-settings-dark.png)                   | 修复前失败证据：暗色设置页提示条与表头对比度不足。不能作为最终主题通过证据。                                                     |
| [06-terminal-dark.png](06-terminal-dark.png)                   | 暗色终端填满窗格并与外壳颜色同步；此截图终端尚未连接，不证明 PTY 执行。PTY 由自动 fixture 回归另证。                             |
| [07-chinese-draft-restored.png](07-chinese-draft-restored.png) | 中文草稿粘贴后，依次访问首页、资源、会话、任务再返回空间，文本保持；现场、任务、检查、日志、diff、报告入口可见。未发送测试文本。 |

逐页操作同时确认：其他页面不显示空间标签；首页显示 Main 空间卡片；资源页显示当前空间资源；联系人与群聊仍在会话页并注明演示范围；任务页读取当前空间任务。返回网页时原 TaskFlow 详情 URL 仍保持。

## 证据边界

CUA `typeText` 中文未产生可见输入，随后使用 `paste` 才观察到准确文本；因此本次只确认中文内容显示与草稿保持。程序 composition/键盘事件回归与这里的粘贴检查均不等同真实 macOS 中文输入法候选窗口验收，后者保持 `undetermined`。带内容通知的精确归属、重启、四窗格、窄窗与多浮层关闭顺序使用本轮 Electron 自动断言，不由空通知截图推导。

## 最后构建复检

- [08-settings-dark-fixed.png](08-settings-dark-fixed.png)、[09-settings-warm.png](09-settings-warm.png)、[10-settings-light.png](10-settings-light.png)：暗色提示和表头已可读，三主题完整窗口均已查看；随后选择跟随系统，控件值更新且外观回到当前系统浅色。系统外观变化的双向同步由 Electron 自动用例另证。
- [11-long-label.png](11-long-label.png)：长中文标签在左栏省略显示，操作按钮仍可用，窗格标题与 AX 提供完整名称。
- [12-reordered-labels.png](12-reordered-labels.png)与[AX 原文](12-reordered-labels.ax.txt)：通过标签菜单“向上移动”，顺序从网页 / 终端 / 会话变为网页 / 会话 / 终端；当前会话与中文草稿不变。拖拽调用未观察到顺序改变，后一次尝试被工具的窗口变化检查中止，因此只判定菜单排序通过，拖拽手势保持 `undetermined`，不据此推断产品缺陷或通过。
- [13-space-switcher.png](13-space-switcher.png)：点击空间名称只展开切换器，网页让位；[14-final-layout.png](14-final-layout.png)：Esc 后焦点回到切换器触发按钮，网页恢复原 TaskFlow 详情地址。

重启后已观察到暗色主题、左侧固定 / 通知收起状态、中文草稿和网页详情地址保留。此次主线程验证没有发送消息、执行任务或接受业务结果。
