# 整合设计决定

本记录将 [INTEGRATION-1](SPEC.md) 映射到实现；不是独立目标或当前通过声明。

## 身份与状态

Main 的 WorkbenchApplication 仍拥有空间、资源、会话、运行与观察归属；renderer 只呈现投影和未提交输入。Provider 仅持有读取句柄、游标和实例代次，service 不新增第二套工作台状态。

稳定资源身份为 workspaceId/environmentId/resourceId/kind；活动实例另带 instanceId/instanceGeneration。Provider 自己的 generation 只负责页面引用、文件游标或连接失效，不冒充 Main 的实例代次。Browser 绑定实际 WebContents，WebContents 数字 ID 只作为来源信息；终端 sessionId 不能替代稳定 resourceId；文件 source/read/watch 返回同一注册资源身份。

观察读取不能占住 Main 命令队列直到 I/O 完成：在队列中校验并冻结归属，异步读取后按请求、取消和实例代次重新核对。切空间不会改变已冻结归属；停止、替换、取消和超时后迟到结果不能进入新上下文。MCP 调用的会话/运行身份由宿主冻结，工具参数不能授予新环境或资源。

## 环境与恢复

local/sandbox/SSH 是可信启动配置定义的环境描述。新文件/终端资源必须显式选择已配置环境，注册后才可被当前空间观察。没有 WSL_OBSERVATION_ROOT 时本地文件能力不可用，不回退到 home。SSH 使用已有 host、user、port、host-key pin、root 与 agent 配置；不复制凭据、不从 shell 内容推导文件能力。

持久化只存稳定环境引用与业务描述，运行句柄及凭据不入快照。旧 schema 1 显式迁移到新版本：旧网页/终端 ID、分割树、标签及会话不变，旧终端对应既有 sandbox；旧 file/ssh 占位没有自动授权。未知较新版本或非法迁移保留原文件并报错。重启恢复描述及历史，不自动重放 PTY/任务。

## 迁入顺序

1. 协议与独立 Provider：实例身份、Browser refs、File root/cursor/watch、Terminal VT 及 SSH transport；保留 delivery 对 task5 的语义修复。
2. Main/service 与生命周期：环境注册、观察请求及结果归属、只读文件/终端连接、证据持久化、MCP 预算与取消。
3. 当前空间 UI：环境选择、只读文件标签、会话上下文观察；保持六入口、通知与主题归属、原生遮挡。修复基线窄窗失败并复验。
4. 全量复验、文档与参赛材料更新、经过主线程审查的本地追加提交。

Provider 的部分覆盖、截断、没有 shell integration、失效游标、连接未知状态都必须明确呈现。文件watch是有损变化提示，不当作未变化的证明。SFTP无原子 beneath；不声称抵御恶意远端并发路径替换，可信远端需权限/chroot范围。
