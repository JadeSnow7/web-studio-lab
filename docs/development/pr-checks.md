# PR head 自动检查

[PR head checks](../../.github/workflows/pr-check.yml) 对每次 PR 新建、更新、重开及退出 Draft 执行一个 macOS ARM64 job。所有命令串行运行，使用 Node 24.21.0、pnpm 10.34.6 和仓库既有的固定 Action SHA；权限只有 `contents: read`。

checkout 明确使用事件中的 `pull_request.head.sha`，并在安装前、构建后及结束时核对 HEAD 和干净工作树。`summary.json` 保存 head、base、tree、merge base、GitHub 事件 SHA 和 workflow 定义 SHA。GitHub 事件 SHA 可能是 merge-ref；它不会被当作被测候选 SHA。新提交需要新运行，旧运行不能给新 HEAD 作验收。

## 检查范围

入口为 `node scripts/pr-check.mjs`，要求环境变量 `PR_HEAD_SHA`、`PR_BASE_SHA` 为完整 40 位 SHA，且工作树干净。它依次执行：

1. 根目录 `pnpm install --frozen-lockfile`；模板 `npm --prefix templates/standard-app ci --ignore-scripts --no-audit --no-fund`。模板不属于 pnpm workspace，必须单独安装。
2. 报告门禁的负例单测；维护目录 `apps`、`packages`、`e2e`、`scripts`、`templates/standard-app` 的 ESLint 和 Prettier；PR merge base 至 head 的全部现存变更文件格式检查及 JS/TS lint。
3. `pnpm typecheck`、完整 `pnpm test`（Vitest、packaging、external-builds）、`pnpm baseline:selftest`、`node scripts/check-docs.mjs`。
4. `pnpm build`；构建通过后执行完整默认 `pnpm exec playwright test --workers=1 --retries=0 --reporter=list,json`。这是 `pnpm test:e2e` 中的构建与默认 Electron 测试，拆开以保留各自退出码，并避免重复构建。没有指定测试文件、grep 或分片。

安装失败会留下后续逐项 `not_run`；普通检查失败仍继续收集其他结果；构建失败不启动 E2E。子进程清除继承的 `WSL_*`、`ELECTRON_RUN_AS_NODE`、`NODE_OPTIONS` 和 `TSESTREE_SINGLE_RUN`，不启用真实模型、guest live、打包、签名或发布。依赖安装需要网络；“离线测试”指用受控 fixture、不使用真实模型或 guest 的默认测试。

## lint 与格式的边界

这是有明确范围的新增门禁，不代表全树 `pnpm lint` 或 `pnpm format:check` 已通过。根 `package.json`、ESLint/Prettier 配置、忽略规则及原命令均不改变。

引入此门禁时，原主线 `b5531e1ac3b3da7adf000f6ba61f2c5b19a0755f` 的全树 lint 有 217 个错误、涉及 139 个原字节文件：138 个在 `docs/acceptance`，另一个是 `tests/vertical-slice/cdp.ts`。格式检查涉及 801 个原字节文件：730 个 acceptance、63 个 verification、4 个 fixtures/vertical-slice、3 个 tests/vertical-slice 和 `docs/architecture/baseline-2026-10-06.md`。这些固定基线与历史证据不纳入维护目录门禁，也不在本次自动格式化。

PR 若改到这些路径，仍进入变更文件检查；例如修改 `tests/vertical-slice/cdp.ts` 会执行其 lint 和格式检查。删除文件无需运行格式工具。工具仍使用现有配置和 ignore；Prettier 无解析器的文件通过 `--ignore-unknown` 排除，不伪称校验了二进制格式。

## 证据与失败规则

每次运行在 `test-results/pr-check/run-*` 新建目录，避免误读旧 JSON。每条命令保留原始日志、开始/结束时间、退出码和信号，汇总为 `summary.json`。Playwright 原始 `playwright.json` 与派生 `e2e-verdict.json` 保留测试路径、行号、每次尝试状态及每一项 skip 原因。`test-results/e2e` 和 `test-results/screens` 保留错误上下文、附件和截图；成功或失败均上传 artifact，保留 14 天。

任何命令非零、必要步骤未运行、报告缺失/损坏/统计不一致、全跳过、flaky、全局错误或源码漂移都会失败。只有同时有 skip/fixme 注解原因和预期 skipped 的测试才算明确配置跳过。串行依赖失败后未运行、无原因跳过单列 `not_run` 并失败；它们不能并入正常 skip。重试关闭，失败后重试通过也不接受为绿色。

该 workflow 是 PR 候选的自动检查入口。通过仍不代表用户接受、真实 guest/模型验收或签名安装包验收，也不改变分支保护规则。
