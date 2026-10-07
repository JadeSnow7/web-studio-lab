# 参与开发

> 状态：2026-10-05 起草，2026-10-06 按新版任务计划修订。`apps/desktop` 已有第一版界面；执行服务、母模板与固定验收还没有实现，相关命令注明落实时机。

## 先读什么

1. [README](README.md)：项目定位、来源与继承边界。
2. [架构约束](docs/ARCHITECTURE.md)：进程边界、依赖方向、安全基线、运行与证据约定。
3. [比赛任务计划](docs/plans/2026-10-os2026-task-plan.md)：范围、排期、任务、三个固定用例的验收标准。

三者冲突时：

- 范围与验收以任务计划为准；
- 实现方式以架构约束为准；
- 二者之间的冲突，先修改其中一份文档，再写代码。

## 环境

- **Node**：主版本与 Electron 内置 Node 一致。Electron 44.5.1 内置 Node 24，`.nvmrc` 与根 `package.json` 的 `engines` 写的是 24。
- **pnpm**：根 `package.json` 的 `packageManager` 固定为 `pnpm@10.34.6`。Node 25 起不再自带 Corepack，可以用 `npm install -g pnpm@10.34.6` 安装，或用 `npx pnpm@10.34.6 <命令>` 临时调用。
- **验证平台**：macOS Apple Silicon。其他平台不作承诺。
- **安装**：一律执行 `pnpm install --frozen-lockfile`。新增或升级依赖时，锁文件必须和代码在同一个提交里。
- `templates/task-app` 有自己的锁文件，单独安装，不加入根 workspace。

## 分支与提交

- `main` 保持可安装，并能通过 `pnpm check`。开发在短生命周期分支上进行，合并后删除分支。
- 分支命名：`feat/<topic>`、`fix/<topic>`、`docs/<topic>`、`chore/<topic>`。
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)：`<type>(<scope>): <描述>`。
  - `type` 取 `feat`、`fix`、`docs`、`refactor`、`test`、`chore`、`ci`、`build`。
  - `scope` 取模块名，例如 `desktop`、`service`、`protocol`、`template`、`acceptance`、`fixtures`。
  - 描述可以用中文或英文，一个提交只做一件事。
- 提交里不能出现密钥、`.env` 文件、`.local/` 下的运行数据或构建产物。
- 最终版本在冻结后打 tag，tag 与提交材料中引用的 commit 必须一致。

比赛窗口很短，提交信息先靠约定，暂不强制加 commitlint 或 husky。CI 只检查能自动验证的部分。

## 代码规范

- 所有 TypeScript 包开启 `strict`，并启用 `noUncheckedIndexedAccess`。避免使用 `any`；确实需要时就地注释原因。
- 格式由 Prettier 决定，静态规则由 ESLint 检查，不另写风格文档。配置在 T03 和根 workspace 一起提交。
- 进程边界（Electron IPC、执行服务消息、事件文件、manifest）上的数据，都用 `packages/protocol` 中的 Zod schema 做运行时校验。类型从 schema 推导，不在别处手写一份重复类型。
- 遵守[架构约束](docs/ARCHITECTURE.md)第 3 节的依赖方向。需要跨越边界时，先改文档，再改代码。
- 新增依赖前先确认技术栈表（任务计划第 2.2 节）里有没有现成方案。同类依赖不重复引入。

## 检查与测试

根目录统一提供以下入口：

| 命令                     | 作用                                             | 状态 |
| ------------------------ | ------------------------------------------------ | ---- |
| `pnpm check`             | 类型检查、lint、格式检查、单元测试               | 已有 |
| `pnpm build`             | 构建桌面应用（不打安装包）                       | 已有 |
| `pnpm test:e2e`          | 用 Playwright 驱动构建后的 Electron 窗口         | 已有 |
| `pnpm package`           | 生成 macOS Apple Silicon 未签名试用包            | 已有 |
| `pnpm test:e2e:packaged` | 对打包后的 `.app` 重跑同一套端到端检查           | 已有 |
| `pnpm verify`            | 对指定工作空间运行固定验收，失败时返回非零退出码 | T09  |
| `pnpm revalidate`        | 不调用模型，对指定最终代码重新执行固定验收       | T09  |

最小 CI 先跑 `pnpm install --frozen-lockfile`、`pnpm check` 和 `pnpm build`，T09 完成后加入无模型复验。CI 不启动 Electron 窗口，不调用模型，也不需要任何密钥。故意出错的 fixture（例如 C3）不纳入默认 CI 的编译范围。

## 验收与证据的规则

这一节是比赛结果是否可信的底线，所有人和 Agent 都必须遵守：

- **不修改固定验收来让结果通过。** 要修改 `acceptance/` 或 `fixtures/`，必须单独提交，说明原因，并在任务计划第 11 节记录。正式运行开始后，验收版本冻结。
- **不放宽 schema、不预写期望数据、不在重启前重新 seed** 来掩盖问题。
- **失败记录照常保留。** 每次重复实验都新增一条记录，不覆盖旧结果。
- **人工介入如实记录**，包括改代码、补关键提示、改配置、手动恢复数据。
- **三种结果分开呈现**：在线运行、无模型复验、历史查看，不混在一起描述。只成功演示过一次，就不写成通用成功率。
- 没有实际运行过的内容，在文档和材料里写“待实现”或“待验证”。

## 从 Web Studio 迁移内容

原项目参考基线为 [`f377db8`](https://github.com/JadeSnow7/Web-Studio/tree/f377db874f0ecba3390804146776b5e5786d2f86)，许可证 Apache-2.0。迁移内容时：

- 在提交说明中写明来源路径和基线 commit，以及是原样复制还是改写。
- 原文件中的版权声明保持不动。引入第三方代码或资源时，同步更新 `THIRD-PARTY-NOTICES.md`（第一次需要时创建）。
- 原项目的 Swift / macOS 实现只作为设计参考，不能写成“已在本仓库实现”。
- 本地运行记录、构建产物、环境配置和凭据一律不迁移。

新增 npm 依赖时，确认其许可证与 Apache-2.0 兼容。冻结前统一生成依赖许可清单（T12）。

## 合并前自查

- [ ] `pnpm check` 和 `pnpm build` 通过（相关入口存在后）。
- [ ] 改动了进程边界上的数据结构时，`packages/protocol` 中的 schema 也已同步更新。
- [ ] 没有改动 `acceptance/` 或 `fixtures/`；如果改了，是单独提交并写明了原因。
- [ ] 没有密钥、`.local/` 内容或构建产物。
- [ ] 新增依赖的锁文件已一起提交，许可证已确认。
- [ ] 改动影响架构约束、命令入口或运行前提时，对应文档已更新。
- [ ] 迁移内容写明了来源，第三方声明已更新。
