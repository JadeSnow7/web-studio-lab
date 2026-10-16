# 2026-10-15 隔离整合、onApp 修复与魔塔接入

本地未提交候选已完成实现，真实 Web Studio 窗口验收通过。没有提交、推送、合并、签名或发布。最终检查与证据索引见同目录 `verification-summary.json`。

## 来源和修改范围

- 基线 HEAD：`b5531e1ac3b3da7adf000f6ba61f2c5b19a0755f`；分支 `agent/mota-preparation-20261015`。
- 工作树：`/private/tmp/wsl-mota-preparation-20261015/lab`。整合冻结的 P0 D、2026-10-15 07:20 UTC 最新 edu、静态导入入口和主线收尾文档；三方整合计划覆盖 126 个路径、11 处冲突。
- 保留来源工作树和魔塔 Downloads 原件。本次只导入临时独立副本到现有 `wsl-sbx-smoke-20261006`，不操作现有 edu 服务。
- `onApp` 保存失败保留实际运行/停止事实、显示持久化错误且不推进持久化版本。Host 捕获异步拒绝并按精确实例撤销候选交接。取消等待模型与源码 helper；清理未确认时保留锁，源码捕获不越过取消及持久化边界。

## 魔塔行为

`mota-web` profile v1 是外部源码导入，不是新增内置模板。Main 只读采集允许路径；本次 322 文件、37,748,618 字节。service 使用有界分块、逐帧确认和完整哈希校验传输到 guest 独立副本，启动受信适配器，不运行来源工程的服务器脚本。

同一 project/AppInstance 提供游戏和编辑器两个不同资源与页面分区。重复打开聚焦原资源，关闭视图保留页面状态和服务；停止及重启更新实例、重新绑定两个页面。发布 loopback 端口后，适配器须确认精确 Origin/实例并通过健康检查；未绑定时拒绝 HTTP。绑定等待有 90 秒上限，覆盖三次各 20 秒端口操作及调度余量；EOF/信号仍立即关闭。

仅 `project/floors/MT1.js` 与 `_server/config.json` 可手动保存。启动重验其他受保护资源；保存核对版本并原子替换。魔塔 Agent/AI 任务、标准 App 控制面和源码导出明确不支持。手动编辑不属于 D 的 Agent-run diff，本次以 guest 原始字节和哈希独立举证。

## 真实窗口验收

第三轮 `mota-live-03` 于 09:44:20–09:46:00 UTC 执行，Playwright exit 0。使用实际构建的 Electron/Main/service、现有 sbx 和原生 Browser 页面；没有模型调用、假 ready 记录或凭据配置。目录选择响应由测试自动提供，未验收人工操作原生选择面板；这不是签名安装包验收。

1. 导入预览不启动服务；确认后自动打开游戏。游戏/编辑器健康响应对应同一 AppInstance，分区不同，无 Node 或 studio preload 注入。
2. 编辑器在 MT1 `(6,10)` 将空地 `0` 改为红药水 `31`，点击保存。guest 文件与浏览器重新读取一致，仅该地图格变化。
3. 刷新游戏并点击新游戏，初始 `(6,11)`、HP 1000。真实 `ArrowUp` 后 HP 1050、药水格消失；再 `Down/Up`，HP 仍为 1050，路线 `up,down,up`。未赋值游戏状态或加载旧存档。
4. 重复打开保持 resource/WebContents 身份和未保存内容；关闭标签仍保持 App 运行。
5. 首次停止确认旧 PID/starttime 消失、旧端口移除、保存内容保留；重启使用新 AppInstance/端口，两个资源恢复且文件哈希不变。
6. 最终 App 为 `stopped`、`cleanupConfirmed=true`，Electron 与只读 keeper 均 exit 0；自有进程/映射清理，原有四条 8081 映射与本轮基线精确一致，cleanupErrors 为空。

成功轮次 project 为 `673b5bbd-6ab0-48f1-8f4b-b9e23499b081`。首次实例 `59cff706-ee8a-4ce4-b616-c5cdfd75d8fe` 使用 guest 36543；重启实例 `b0e4e0cb-8493-4c12-a62d-7dcc333ad98b` 使用 guest 36817。以上端口已关闭。

MT1 保存前 SHA-256：`b700c9fe6d918b813c46ee6826b918ae7d83bb3171851ad327d57ff84bc31ce6`；保存后：`cbdfeb44e7a4b18d72f755d20a469c21c07308142e60bc29e1695f82392f8562`，均为 2,982 字节。

## 检查和保留的失败

- `pnpm typecheck`、`pnpm lint`、`pnpm build` 均通过；Mota Python 边界 21 项、源码快照 Python 24 项、离线 baseline selftest 12 项通过。
- 最终打包/edu-source/external-builds Node 测试 75 项通过。Electron Node 24 需要关闭测试进程的 ASAR 虚拟文件系统（`--import=data:text/javascript,process.noAsar=true`）；此前两项临时目录清理失败记录保留，源码和断言未改。
- 首轮全 Vitest 为 1,707 通过、18 跳过。增加两项重启回归后，最终默认并发运行出现两项旧 local-terminal 清理失败；两文件一起复验又在另一清理用例失败，分别原样运行则 2/2、6/6 通过。相关实现和测试相对 HEAD 未改，原因未确定，不能称默认并发稳定通过。单 worker 全量复验为 1,709 通过、18 条件跳过，未改超时、断言或跳过条件。
- 全仓格式检查仍因来源文档 `docs/acceptance/consolidation-20261011/closeout-20261014.md` 一处失败，保留来源字节。其余当前文件格式通过。来源树历史 217 个 lint 错误、801 个格式问题不是当前结果；整合来源包含历史证据目录排除规则，本次未为制造通过降低断言或新增排除项。
- `mota-live-01` 在 App 启动前发现已有映射。测试随后保留基线并用整场只读 keeper，避免 VM 自动停止及重新分配端口干扰验证。
- `mota-live-02` 完成编辑、药水和首次停止，但第二实例在绑定前退出，清理未确认门禁保留失败。已确认原 15 秒绑定预算短于宿主端口操作预算，改为有限 90 秒并增加真实延迟 16 秒回归；不能据现有证据断言第二轮退出触发一定是该超时。随后第三轮全链路通过。第二轮自有孤儿窗口和精确归属的无监听映射经独立核对清理，原有映射保留。

## 证据和后续边界

原始证据位于 `/private/tmp/wsl-mota-preparation-20261015/implementation/evidence`；任务交付目录包含精选回执、前后文件、截图及完整候选补丁，不包含 Electron 私有 profile、Cookies 或凭据。

未执行两轮 AI 游戏演示、幸运金币改动或联网搜索。此前幸运金币、41F 机关及现有 AI/搜索能力的只读核对保留在 `mota-demo-readonly-check.md`。后续产品内 AI 玩游戏需要另行实现魔塔状态/动作接线，不能以本次手动验收声称已支持。
