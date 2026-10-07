# 公开网页到空间到 Docker Sandbox：验收合同 v1

冻结日期：2026-10-06。来源：用户明确授权实现并复测原测试失败的最小链路；sdx 指 Docker Sandboxes。
基线 HEAD 536f0a1948e522a09310aa20784ec512476dc7be 加已核验的 9630 工作树内容。原主目录与 9630 不改动。既有失败报告 web-resource-round-104719 永久保留。

## 可观察成功条件

A. 在真实 Mac Web Studio Lab 输入 https://example.com/ 与 https://docs.docker.com/，显示实际获取的 URL、标题和 HTML 正文文本。公开页面明确为只读文档；不承诺原站动态交互或布局。
B. 将当前成功显示的公开文档加入 taskflow-demo 空间；保留来源 URL、标题、正文、抓取时间、正文摘要、原始响应摘要、页面身份与版本。重复相同内容幂等。导航后不得保存旧页面为新页面。
C. 空间列表可查看、更新和删除资源，更新后新版本可读，删除后下一轮不可枚举或读取；同空间运行中的资源任务禁止变更，错误可见。
D. 现有 Docker Sandbox 中有限只读 MCP 能枚举当前会话空间的资源并按 resourceId/version 读取；个人会话无空间资源。不能任意路径、任意 URL、写资源或访问其他空间。Linux 密封内存快照确证不能写。
E. 实际现有 Codex Agent 通过该 MCP 调用读取本轮挂载资源的 URL、标题、正文，捕获真实工具调用证据；仅 MCP 客户端实测不能代替模型实测。网络或既有授权失败必须报告失败，不模拟。
F. 类型、单元、集成与真实 UI 验证覆盖危险 scheme、公网/private DNS/IPv4/IPv6、重定向、加载失败、重复挂载、空间隔离、导航绑定、更新删除、readonly/path traversal。保留失败证据，不得降低断言。

## 不变量

公开网页无 preload、Node、IPC、权限、窗口、下载、子资源、脚本、框架或表单能力；trusted shell 保持隔离和 webSecurity。
HTTPS broker 对每个跳转的 DNS 全部地址做公网校验，并把 HTTPS 请求固定到一个已校验 IP，保留 hostname/SNI/证书校验。只允许 HTTPS 443、无 URL 凭据，无浏览器 Cookie/Auth/Referrer。超时、跳转、响应大小、MIME、编码均有界。
解析真实响应为 title 与 body 文本，跳过 script/style/template 等非正文；使用固定转义模板重新显示，不复制原 HTML/属性/CSS/响应头/网络提示。UTF-8 范围外明确失败。
只保存用户加入的公开文档。不引入 host mount、Docker socket、新凭据、持久 MCP 配置或付费 API。网页内容是非可信资料，不能改变工具权限。现有 sandbox 同 UID 不承诺 OS 级空间保密；资源 API 范围隔离与只读权威必须实测。
不提交、不推送、不创建 PR、不合并。安全敏感持久配置变更超出本轮；若必需先报告。

## 接口设计（实现后公开类型以 packages/protocol/src/resources.ts 为权威）

PageResourceSnapshot：page:PageIdentity, requestedUrl:string, url:string (实际最终 URL), title:string, text:string, capturedAt:ISO string, sourceSha256:64hex, contentSha256:64hex, extractionVersion:"html-text-v1", truncated:boolean。
SpaceResource：以上字段加 spaceId:string, resourceId:UUID, version:positive integer。
ResourceCollection：spaceId, revision:nonnegative integer, resources:SpaceResource[]。
ResourceBundle：conversationId:ChatSlot, generation:string, turnId:string, spaceId:string|null, collectionRevision:number, resources:SpaceResource[]。
限制：每条正文 UTF-8 <=65536 bytes；每空间最多16条；整包 JSON UTF-8 <=524288 bytes；截断显式标记。
StudioApi.resources.list(spaceId); capture(spaceId, expectedPage, resourceId?); remove(spaceId,resourceId)，返回 ResourceCollection。capture 的正文只来自 main PreviewController.captureResource(expectedPage)，不得接受 renderer 自报正文。更新同 resourceId 要求同 URL；新增按最终规范 URL 去重，内容不变版本不变，内容改变版本+1；不同空间身份不同。
Service ResourceStore(root) 在内部固定文件保存：list(spaceId), save(spaceId,snapshot,resourceId?), remove(spaceId,resourceId)。操作 async。IPC 目前只允许已有 taskflow-demo 空间；store 单测支持第二空间。JSON 边界严格 schema、原子替换；禁止路径参数。
CodexChat 构造第4参数 resources?: { list(spaceId):Promise<ResourceCollection> }。新增 assertResourceMutationAllowed(spaceId):void, invalidateResources(spaceId):void。Service index 在 save/remove 前检查，完成后 invalidate（切断旧 CLI thread，保留 UI 历史并提示资源已变更）；taskflow-demo 只绑定 conv-space-taskflow-demo-impl。个人空 bundle。未知清理状态阻止共享 sandbox 新资源任务。
GuestStart 可增加 resourceBundle；host 解析后由 guest-helper 创建 sealed memfd，把固定 MCP server 代码与内部 fd 路径交给 Codex 的单次 -c 配置。工具 list_resources 与 read_resource(resourceId,version) 有 readonly annotations，拒未知参数/写方法/路径。无资源也提供空列表，返回 data 标注 untrusted。
main ipc/resources、protocol 与 service index 的装配由 backend coder 独占；preview 文件与 parse5 依赖/锁文件由 navigation coder 独占；codex-chat/sbx/guest-helper/MCP由 guest coder 独占；renderer、UI E2E 与 DESIGN/UX/premium 文档由 UI coder 独占。

## 验证方法与阶段

先保存既有 check 结果及各子模块目标失败测试，再开放实现。固定公开网页、受控离线恶意 fixture、资源模型测试与 guest 只读测试互补。最终构建后启动隔离 user-data Mac Electron，使用真实界面导航/保存/读取，保留脱敏截图、资源身份与散列。实际 Agent 测试使用已有授权，任务结束验证 owned processes 清理；原会话完成信号引用既有正式 turnCompleted 记录。
证据放 ~/workspace/_agent-reports/20261006/public-resources-implementation；本仓库 docs/verification/2026-10-06-public-resources 保存合同与任务索引。旧失败不覆盖。
