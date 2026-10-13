# Web Studio Lab 标准应用 1.0.0

唯一母模板：React / TypeScript / Vite 前端、Node / Hono API、Drizzle / 磁盘 PGlite、Zod 和 Tailwind。只有欢迎页、连接状态、最小 Button 组件与基础设施 API，没有预制 TaskFlow 业务。本目录有独立 npm 锁文件，不参与工作台根依赖升级或 VS001 冻结 fixture。

## 环境和启动

Node >=24（本轮本机 26.5.0），npm 11.17.0。所有命令在本目录/其完整运行副本中执行。不能让两个进程同时打开同一 PGlite dataDir；迁移/seed CLI 也须在应用停止时执行。

```bash
npm ci --workspaces=false
npm run template:verify
npm run db:migrate
npm run db:seed
npm run check
npm run build
WSL_WORKSPACE_ID=space-1 WSL_ENVIRONMENT_ID=sbx-1 WSL_PROJECT_ID=project-1 WSL_APP_INSTANCE_ID=app-1 WSL_DEV_SESSIONS=1 npm start
```

正式健康测试使用 `npm run build` 后的 `npm start`：Hono 在唯一端口提供 `/api/*` 和 `dist/client`。`HOST` 默认 `0.0.0.0` 供 sbx 端口转发，`PORT` 默认 3000。宿主转发必须绑定 loopback；由工作台持有应用进程与转发生命周期。退出 Codex、关闭 Browser 视图都不是停止 App 的理由。SIGTERM/SIGINT 会停止 HTTP 接入、关闭 PGlite 并退出；超出 8 秒排空时间以非零状态失败。

`npm run dev` 同时启动 Node 的 TS watch 和 Vite 5173，Vite 将 `/api` 代理到 `PORT`；退出开发入口将停止两者。正式验收和端口身份断言不用 Vite 开发入口。

## 环境和身份

| 变量                  | 作用 / 本地默认                                  |
| --------------------- | ------------------------------------------------ |
| `WSL_WORKSPACE_ID`    | 工作空间；`local-workspace`                      |
| `WSL_ENVIRONMENT_ID`  | 沙箱环境；`local-environment`                    |
| `WSL_PROJECT_ID`      | 源码项目；`local-project`                        |
| `WSL_APP_INSTANCE_ID` | 应用实例，不能用 task runId 代替；`local-app`    |
| `WSL_DATA_DIR`        | 磁盘 PGlite 目录；`.data/pglite`，相对 guest cwd |
| `WSL_DEV_SESSIONS`    | 仅为 `1` 时开放受控开发 A/B 会话；默认禁用       |

工作台托管时必须显式传入全部四个身份字段，不能使用本地默认值。`GET /api/health` 对真实数据库执行 `SELECT 1`，返回 `{ok:true,templateId:"wsl-standard-app",templateVersion:"1.0.0",identity:{workspaceId,environmentId,projectId,appInstanceId}}`。健康失败返回非 2xx；身份不符必须拒绝挂载。前端从同源 API 显示 projectId 与 appInstanceId。

## 迁移、seed 和会话

`npm run db:migrate` 运行版本化 Drizzle SQL 迁移；应用启动也执行幂等迁移。`npm run db:seed` 只为 A/B 各插入 `welcome=Ready`，冲突不覆盖。重启、重新 seed、停止服务和导出源码均不得删除 dataDir。源码导出应排除 `.data`、`node_modules` 和 `dist`。

A/B 只用于受控开发测试，无 OAuth、用户注册或生产访问控制。该开关不是公开部署安全边界。`POST /api/dev/session` JSON `{"userId":"A"}` 或 `B` 发出随机会话 cookie（HttpOnly / SameSite=Strict，8 小时过期）；cookie 名按 appInstanceId 分离，防止同一宿主不同端口混用。会话和用户数据保存在 PGlite。变更请求需要 JSON；浏览器 Origin 必须同源。

最小存储探针 `GET /api/kv/:key` 与 `PUT /api/kv/:key`（JSON `{"value":"..."}`）要求会话，按 A/B 隔离；只用于基础设施持久化验收。键 1–64 个字母/数字/下划线/短横线，值最长 4096 字符。不存在返回 404，无会话返回 401，不合法输入返回 400。

## 验证与版本

`npm run check` 做前后端严格类型检查和真实磁盘数据库测试（重复迁移/seed、A/B 隔离、参数与会话边界、关闭重开后的持久化）。`npm run build && node scripts/http-smoke.mjs` 启动真实生产 Node 进程，以 HTTP 验证 HTML/JS、身份、写入、SIGTERM、端口释放与重启读取；它只创建临时数据目录，不使用用户数据。

`template-manifest.json` 是模板内容 SHA256 清单，含 package-lock、源码、SQL、脚本和本 README。生成：`npm run template:hash`；验证：`npm run template:verify`。清单自身、node_modules/dist/data/测试临时目录/日志不参与计算。模板版本是发行身份，内容 SHA256 是精确输入身份；实例源码变化应由工作台单独登记，不能通过重生成母模板清单隐藏变化。

## 沙箱离线依赖准备

沙箱 npm 网络不可达时，可在已授权联网的宿主运行以下命令。打包显式设置 `COPYFILE_DISABLE=1`，避免 macOS AppleDouble 元数据条目。它从本模板实际锁文件执行 `npm ci --os=linux --cpu=arm64 --libc=glibc --ignore-scripts`，检查目标 native 包版本，生成以 `node_modules/` 为根的归档与严格四字段校验旁文件，不修改模板锁或全局网络。此路径只适用 Linux ARM64 glibc 沙箱。

```bash
node scripts/prepare-offline-dependencies.mjs /tmp/wsl-template-linux-arm64.tar.gz
# 已具备相同 npm 缓存时，可验证完全离线重建：
node scripts/prepare-offline-dependencies.mjs /tmp/wsl-template-linux-arm64-offline.tar.gz --offline
```

旁文件 `<archive>.json` 包含 `archiveSha256`、`lockSha256`、`platform:"linux"`、`arch:"arm64"`；lock SHA 来自实际安装 staging，且须与模板当前锁一致。运行时先验证二者哈希及平台，再将归档解入该实例 guest cwd。归档不包含凭据、数据目录、应用源码或构建产物；不同执行时间生成的 tar 字节哈希可不同，但各自对应明确锁文件。脚本拒绝覆盖已有归档，也拒绝写入母模板目录。
