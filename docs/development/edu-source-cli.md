# edu-web 源码 CLI

入口为 [`scripts/edu-source.mjs`](../../scripts/edu-source.mjs)，提供 `snapshot`、`verify`、`merge`、`resolve`。它独立处理本机源码与 bundle；运行只需 Node 24 和 Git，不需要安装仓库 npm 依赖、Electron、Python、sandbox 或模型。测试另需系统的 `mkfifo`，支持范围为 macOS/Linux。

此工具保留 `edu-web` profile v1 的固定白名单，不是任意项目备份工具。它没有工作台导入、编辑器、运行、导出或模型任务接线；`verify` 保留对已有 `workbench-export` 格式的校验兼容，不能据此宣称当前产品已提供该导出能力。

## 输入、输出与边界

`snapshot --root` 必须指向有提交的 Git 工作树顶层。清单记录该工作树的 HEAD、dirty 状态、排序后的文件列表、逐文件 SHA-256 和整体摘要；不会提交、暂存或改写输入。

- 根文档：`README.md`、`SPEC.md`、`API.md`、`DESIGN.md`、`UX-CONTRACT.md`、`AGENTS.md`。
- 可选说明：`docs/development/webstudiolab.md`。
- 前端：`admin/` 中 `.json`、`.ts`、`.tsx`、`.js`、`.mjs`、`.css`、`.html`、`.md`。
- 后端：`server/` 中 `.py`、`.txt`、`.lock`、`.md`。
- 必需文件：`admin/package.json`、`admin/package-lock.json`、`server/app.py`、`server/requirements.lock`、`server/requirements-test.lock`、`server/wsl_runtime.py`。
- 预算：最多 256 文件、源文件合计 524,288 字节、路径最多 500 字符；单文件 base64 长度上限 4,000,000 字符。

采集跳过 `.git`、`node_modules`、`dist`、`.venv`、`venv`、`__pycache__`、`.pytest_cache`、`.ruff_cache`、`.mypy_cache`、`.vite`、`.data`、`data`、`.runtime`、`coverage` 目录，以及以 `.env`、`.wsl-` 开头的路径段。白名单之外的源码不会收录；被选目录中的符号链接和特殊文件、被选文件的硬链接会被拒绝。路径和预算约束同样适用于 bundle 校验。

每个 `--output` 必须是尚不存在的路径，其父目录需已存在。bundle 包含 `manifest.json` 和 `source/`；新目录权限为 `0700`，文件为 `0600`。输入 bundle 保持原样。输出不是事务性发布：磁盘等 I/O 失败可能留下不完整目录，应保留现场并在排查后改用新的输出路径。不要在采集时并行编辑输入；重复采集与文件身份核对用于发现变化，不提供跨进程文件系统锁或来源签名。

## 四个命令

以下命令从 Web Studio Lab 仓库根目录执行。示例 `/path/to/...` 均需替换为实际路径；输出宜放在被采集工作树之外，避免下一次 dirty 状态包含生成物。也可用 `pnpm edu:source <command> ...` 调用相同入口。

```sh
node scripts/edu-source.mjs --help
node scripts/edu-source.mjs snapshot --root /path/to/checkout --output /path/to/bundles/base
node scripts/edu-source.mjs verify --bundle /path/to/bundles/base
node scripts/edu-source.mjs merge \
  --base /path/to/bundles/base \
  --local /path/to/bundles/local \
  --upstream /path/to/bundles/upstream \
  --output /path/to/bundles/merge-result
```

`merge` 使用文件字节进行三方选择：两边相同则保留该版本，只有一边相对 base 变化则采用变化的一边；两边不同且都相对 base 变化时报告冲突。它不做文本行级合并，也不修改 Git 分支。无冲突时生成 `manual-merge-candidate`，保存三个输入的整体摘要；有冲突时只生成 `conflicts.json`，包含冲突路径和三方文件摘要，不生成可校验 bundle。

人工解决冲突的步骤：

1. 保留原 `base`、`local`、`upstream` bundle 和 `conflicts.json`。
2. 在另一个 Git 工作树中准备完整结果。保留三方选择确定的全部无冲突内容与删除，只修改实际冲突路径；可删除冲突的可选文件，不能删除必需文件或添加无关文件。
3. 用 `snapshot` 采集人工结果，再以原三方 bundle 调用 `resolve`。不要将已有合并候选或 `workbench-export` 直接当作 `--resolved`。

```sh
node scripts/edu-source.mjs snapshot \
  --root /path/to/manual-resolution-checkout \
  --output /path/to/bundles/resolved-snapshot
node scripts/edu-source.mjs resolve \
  --base /path/to/bundles/base \
  --local /path/to/bundles/local \
  --upstream /path/to/bundles/upstream \
  --resolved /path/to/bundles/resolved-snapshot \
  --output /path/to/bundles/resolved-candidate
node scripts/edu-source.mjs verify --bundle /path/to/bundles/resolved-candidate
```

`resolve` 会重新校验四个输入，并要求原三方确有冲突；无冲突时应使用 `merge`。它拒绝人工结果对无冲突文件的编辑或删除、无关新增、恢复已确定删除的文件。输出保留人工快照的 Git commit/dirty 和原三方摘要，类型仍为 `manual-merge-candidate`。解决结果的业务正确性与接受决定由用户另行审查。

退出码：`0` 表示命令成功（或打印帮助）；`1` 表示参数、校验或 I/O 错误；`2` 仅表示 `merge` 发现冲突。成功命令输出包含 `sourceKind`、文件数和整体摘要的 JSON；冲突时 stdout 输出路径，详情在 `conflicts.json`。`verify` 证明清单与 bundle 当前内容一致，不证明业务、运行或产品验收通过。

## 测试与来源

定向测试使用合成目录，不执行被采集的前后端源码，也不调用模型或网络：

```sh
node --check scripts/edu-source.mjs
node --check scripts/edu-source.test.mjs
node --test scripts/edu-source.test.mjs
node scripts/check-docs.mjs
```

`pnpm test:edu-source` 对应上述 Node 测试；根 `pnpm test` 在已有检查之后调用它。测试覆盖白名单、文件和字节预算、路径穿越、链接/特殊文件、清单篡改、三方冲突、人工解决范围、输入保全及 Git 来源状态。测试创建的 Git 仓库与提交仅位于测试临时目录。

[独立 PR 检查](../../.github/workflows/edu-source-cli.yml) 在 Ubuntu 24.04、Node 24.21.0 上执行上述四个命令，不安装 npm 依赖。它检出 PR head SHA，并记录实际 head/base/tree、运行环境及每项命令退出码；手动运行时 base 取检出的远端默认分支。失败也上传日志。此检查只覆盖独立 CLI 和文档，不替代全仓检查、Electron E2E 或产品验收。

实现与全部测试原字节提取自本仓库 [PR #9](https://github.com/JadeSnow7/web-studio-lab/pull/9) 的固定提交 `b5ded08630e279e0c663312411895c90cabab598`：

- [`scripts/edu-source.mjs`](https://github.com/JadeSnow7/web-studio-lab/blob/b5ded08630e279e0c663312411895c90cabab598/scripts/edu-source.mjs)
- [`scripts/edu-source.test.mjs`](https://github.com/JadeSnow7/web-studio-lab/blob/b5ded08630e279e0c663312411895c90cabab598/scripts/edu-source.test.mjs)

独立提取基于 main `b5531e1ac3b3da7adf000f6ba61f2c5b19a0755f`，仅新增命令/测试入口和本文档，不继承该 PR 的旧 edu 产品接入。源码继续适用仓库 [Apache-2.0 许可证](../../LICENSE)。历史分支结果不作为本次提取的验证结果；实际检查状态以本次 PR 的固定提交和执行证据为准。
