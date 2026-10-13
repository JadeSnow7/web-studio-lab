# 标准应用与安装器整合：公开验收摘要

本文件是 2026-10-09 本机验收的公开摘要，不是原始运行回执。原始日志、profile、截图、运行目录、导出与安装包保留在本地，未随本次提交上传；其中含个人绝对路径及运行现场。既有冻结 fixture、验收器、根依赖锁和历史已跟踪回执未改写。原始记录的内容哈希及公开源码快照见 [证据索引](evidence-index.json)。哈希可用于日后核对，不能独立证明运行发生。

## 版本与范围

- 整合 main 基线：`f77ff9620d3d83d78eb4f62490c684b8155e48b2`。
- Adapter 来源：`5c95c0750fe5acc165e70671590b3c690224dd8a`（PR #4）。
- 原最终验收源码快照：`e8f09dc41c2f162945a024477b08142a1a944d78b93b527a8d94b21f0ae9d03f`，317 文件，算法为排序后的 path→SHA256 映射紧凑 JSON UTF-8 的 SHA256。
- 提交前逐文件核对原快照无漂移。为公开提交，之后仅更新 README、CONTRIBUTING、运行时文档及验收入口的链接与结果说明，并新增本公开摘要/索引；实现源码、模板、锁、测试、打包脚本仍为验收字节。文档变化另在索引中列出，不能把提交后的完整树指纹冒充原验收指纹。

实现唯一 React/TS/Vite + Node/Hono + Drizzle/PGlite + Zod 母模板，含独立锁、版本哈希、磁盘 dataDir、迁移、幂等 seed 和明确命令。没有预制完整 TaskFlow 业务，A/B 仅为受控开发会话。

App、chat、environment 使用统一配置的 SbxConnection；模板载荷随安装包提供，Main 验证内容、锁和归档。工作台独立管理 App 服务，使用专属 guest cwd，绑定 workspace/environment/project/app-instance。生产入口由 Hono 单端口提供静态页面及 API，产品原生 Browser 经 loopback 访问并检查实例身份。

真实联调修复了关闭后 durable 状态恢复，以及 sbx 持久端口请求撤销。端口清理先核对本实例唯一映射，再撤销原 guestPort/tcp4 请求，避免仅删除即时 host 绑定后唤醒复现，或误删其他实例映射。

## 最终验证结果

| 项目                   | 结果与边界                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 单元测试               | 508 通过、15 跳过；70 文件通过、6 文件跳过                                                                                          |
| 打包测试               | 27 通过、0 跳过                                                                                                                     |
| fixture UI 回归        | 59 通过、7 个显式 live 跳过；不是59项打包实测                                                                                       |
| 类型检查、内部包构建   | 通过；安装包未签名、公证或发布                                                                                                      |
| 修改文件静态检查       | 60 代码文件 lint、71 源文件格式及18规范文档检查通过                                                                                 |
| 最终安装包真实产品闭环 | 1通过；Browser、health/identity、A/B隔离、停/重启、关闭/重开工作台、数据保留、源码导出和取消                                        |
| 真实 sbx 故障注入      | 1通过、1个其他用例跳过；导入取消、guest取消、健康探针故障超时与清理。运行源码 AppService，不冒充打包UI自然超时                      |
| 损坏包负例             | 1通过；只修改复制包归档，设置页显示校验错误并禁用 sandbox；原包哈希未变                                                             |
| 导出源码               | 独立目录离线安装、模板校验、check/build、真实HTTP及重启持久化通过                                                                   |
| 冻结自检               | 12/12通过                                                                                                                           |
| 冻结VS001              | 一次真实Codex，43.151秒，120秒总预算内B01–B05全部通过；只改运行副本src/App.tsx，同一CDP target独立观察/断言/截图，cleanupErrors为空 |

VS001 runId 为 `6671012a-6e2e-4991-a9f9-fe7d9f49bbb4`，输入指纹为 `0bf9ba70a6de80f4bb13d85e10f60ad11424f3980bf39c67122954b67ffa2841`。使用既有授权的 `gpt-6-astra`，未重试模型。实际既有 guest Codex 0.149.1，包内载荷和宿主 Codex 0.160.0；没有擅自升级既有沙箱。

打包 App 使用全新独立 profile；测试 runner 预备指向已有沙箱的 runtime.json。App 内实测 PATH 只有系统目录、没有 WSL_*，sbx 来自已保存的 Sbx.app 配置。这不等同全新机器首次安装或登录验收。guest 对 npm registry 的 React 请求实际403，应用使用独立锁生成并校验的 Linux ARM64/glibc 缓存载荷完成启动；没有更改全局网络或凭据。

最后 sbx 唤醒重新分配原有 host 端口后，仍只出现原六个 guest 映射，本轮应用映射未复现。guest 无本轮 Node/helper 进程，本轮 Electron 已退出，既有用户 App 和其他工作树保留。

## 复现入口

在已准备工具链的仓库中执行 `pnpm typecheck`、`pnpm test`、`pnpm exec playwright test`。默认测试不调用模型。缓存齐备时 `WSL_PAYLOAD_OFFLINE=1 pnpm payloads:prepare` 与 `pnpm package:unsigned` 可生成内部测试包；缺缓存时明确失败。

模板命令与环境变量见 [模板 README](../../../templates/standard-app/README.md)。真实打包入口为 `e2e/managed-app-live.spec.ts`，需显式设置 `WSL_APP_LIVE=1`、`WSL_E2E_TARGET=packaged`、`WSL_E2E_APP_PATH`、实际 `WSL_SBX_BIN` 和 `WSL_SBX_NAME`；必须使用已授权环境。损坏复制包负例为 `e2e/managed-app-packaged-rejection.spec.ts`。冻结模型验收入口为 `tests/vertical-slice/run.ts`，需要额外显式授权，不属于普通测试或CI默认行为。

未签名内部 App 只通过正常系统打开流程使用。若系统安全检查阻止打开，停止并保留提示；不要删除 quarantine 或禁用 Gatekeeper。

## 限制与历史失败

全仓 lint 曾报1986错误、全仓格式775文件告警，主要涉及生成物及历史/冻结文件；没有通过全仓重写隐藏问题。最终修改文件静态检查通过，不声明仓库总检查全绿。R3 native focus 曾在整合树和精确main基线均失败，最终原断言通过，仍记录为焦点不稳定风险。

初轮 durable恢复和端口持久请求缺陷的失败回执均保留本地，最终修复后重验通过。旧来源树日志不计入本次通过。首次安装/登录、完整OAuth、多模板、多Agent、G0/C1–C3业务、正式签名公证和发布均不在完成范围。

仓库当前只有 `Signed competition release` Actions（v* tag push或手动tag输入），包含签名、公证及Release发布。普通整合分支推送不会运行它；本次提交没有修改workflow或创建新的发布入口。
