# 实施 prompt：状态降噪与统一状态接口

用于 Claude Code。主代理：**Opus 5.5，effort high**；子代理：**Sonnet 5.5，effort high**（定义见同目录 [agents.json](agents.json)）。

## 1. 启动（在终端执行）

```bash
# 1) 从 917f375 建独立工作树与分支（不动主工作树）
cd /Users/huaodong/workspace/web-studio-lab
git worktree add /Users/huaodong/workspace/_worktrees/status-surface-20261011 -b agent/status-surface 917f375

# 2) 把设计目录带入新工作树（它在主工作树中是未跟踪文件，检出 917f375 不会自动出现）
cp -R docs/design/2026-10-11-status-surface \
  /Users/huaodong/workspace/_worktrees/status-surface-20261011/docs/design/

# 3) 安装依赖
cd /Users/huaodong/workspace/_worktrees/status-surface-20261011
pnpm install --frozen-lockfile

# 4) 确保没有会覆盖子代理设置的环境变量
#    CLAUDE_CODE_EFFORT_LEVEL 会覆盖子代理定义里的 effort
unset CLAUDE_CODE_EFFORT_LEVEL CLAUDE_CODE_SUBAGENT_MODEL

# 5) 启动：主代理 Opus 5.5 / high，子代理来自 agents.json
claude --model claude-opus-5-5 --effort high \
  --agents "$(cat docs/design/2026-10-11-status-surface/agents.json)"
```

进入会话后先确认：

- `/model` 显示 Opus 5.5；`/effort status` 显示 high
- `/agents` 列出 `status-coder` 与 `status-reviewer`

`--agents` 只对本次会话生效，不在仓库里留下 `.claude/agents/` 文件。如果需要多次会话复用，再启动时带同一参数即可。

如果 `pnpm install` 时 Electron 二进制下载失败，参考 `docs/acceptance/consolidation-20261011/README.md`「本轮验证」一节的处理方式，不修改源码或锁文件。

## 2. Prompt（整段粘贴）

````text
你是本次实施的主代理。任务：按已审核通过的设计，在当前工作树实现「状态降噪与统一状态接口」。

## 必读（按顺序）
1. AGENTS.md、CONTRIBUTING.md、docs/ARCHITECTURE.md：仓库规则，必须遵守。
2. docs/design/2026-10-11-status-surface/ 下：README.md → review-response.md → design.md → status-interface.md → plan.md → contract-changes.md。
3. mockups/*.png 作视觉参照：after.png 为健康状态，after-anomaly.png 为同一异常集合，tiers.png 为通道规则。
设计文档中的行号、字段与测试引用均对应提交 917f375。

## 已确认的决策，不再讨论
1. 诊断仅在 rendererSource().kind === 'dev-server' 或 WSL_DEBUG_STATUS=1 时启用；pnpm build 产物与正式包默认关闭。
2. 健康终端在侧栏保留绿色实心点。
3. 按 contract-changes.md 修订 UX-CONTRACT.md 与 DESIGN.md。

## 开始前核对
- pwd 为 /Users/huaodong/workspace/_worktrees/status-surface-20261011；当前分支为 agent/status-surface；HEAD 为 917f375；除 docs/design/2026-10-11-status-surface/ 外工作树干净。任一项不符就停下告诉我。
- 第一个提交只纳入设计目录：docs: add status surface design。
- 记录基线：运行 pnpm typecheck、pnpm test、pnpm lint、pnpm format:check，保存失败计数（既有：lint 217、格式 801），后续按「不新增失败」判定。

## 分工
- 你：拆解任务、派发、审阅 diff、运行验证、提交、向我汇报。按 AGENTS.md，源码与测试修改优先委派给 status-coder；每个文件同一时间只有一个写入者，不要并行派发会写同一文件的任务。
- status-coder（Sonnet 5.5 / high）：在你指定的文件范围内实现代码与测试，不碰 git 状态。
- status-reviewer（Sonnet 5.5 / high，只读）：每个阶段结束后独立审查 diff。
- 派发时不要传 model 或 effort 参数：它们会覆盖子代理定义里的 Sonnet 5.5 / high。

## 执行
严格按 plan.md：P0 → P1 → P2（8 个区域，每个区域一个提交）→ P3 → P4。每个阶段或区域：
1. 派 status-coder：写明要改的文件、完成标准（引用 plan.md 与 status-interface.md 的对应小节）、要运行的定向检查。
2. 你审阅 diff 并运行该阶段的验证命令（plan.md 列出的命令）。
3. 派 status-reviewer：提供阶段名、相关设计小节、diff 范围（git diff <上一个提交>..HEAD 或工作区 diff）。修复其报告的 P1、P2；P3 由你判断并记录。
4. 提交：一个阶段或区域一个提交，Conventional Commits 标题，中文正文写明行为变化。
5. 用三五行向我汇报：提交哈希、验证结果、未运行项。然后继续。

P2 每个区域额外完成：plan.md §4 对应的 E2E 定位调整；§5 对应的可见性与键盘用例；白 / 暗 / 暖三主题与 1080px 以下窄窗的正常、异常两种状态截图，保存到 test-results/screens/status-surface/ 并目视复核。

## 硬性约束（违反即返工）
- packages/protocol 只放 DTO 与按域 raw 白名单 schema；事实投影在 apps/desktop/src/shared/status（同时加入 tsconfig.node.json 与 tsconfig.web.json 的 include）；展示投影只在 renderer；组件只通过 useStatusView 取状态。
- 键为 domain:entityId:facet。control / unresolved / progress 进常驻通道，不折叠、不因交互降级；只有 confirmation 与 hint 因交互消失；instanceToken 变化使确认失效。
- ExecutionStatus 只产出 capability，不进 Toast、标题栏或状态槽。
- 输入框可访问名称保持「会话消息」；「发送到 · …」改为 aria-describedby 描述。环境级 label 用 sr-only 文本输出。
- 诊断：raw 白名单、脱敏、大小上限按 status-interface.md §8；PageCapture 只能在面板内查看，不进复制、导出或 NDJSON。未启用时 window.studio 仍恰为 6 个键。
- 不改 Main 业务状态、命令与持久化格式；不建事件总线、插件或通用框架；不新增全局导航、右侧会话或配色。
- E2E 只按 plan.md §4 调整定位方式，语义不变；不删断言、不放宽断言、不扩大 ignore。

## 遇到以下情况停下来问我
- 设计与 917f375 的源码事实不符，或实现必须偏离设计文档；
- 需要修改设计未列出的合同条款、协议业务字段或 Main 命令；
- 定向检查出现非既有失败，两轮修复后仍失败；
- 需要真实模型、sandbox live、签名公证、推送、创建远端 PR 或发布。

## 禁止
- 不 push、不创建远端 PR、不发布或部署；不 reset、不自动 stash、不改写历史。
- 不修改主工作树 /Users/huaodong/workspace/web-studio-lab 以及其他工作树。
- *-live.spec.ts 与 packaged 用例只做代码调整，不运行，交付时标为 not_run。

## 交付
全部阶段完成后，写 docs/acceptance/status-surface-20261011/README.md（沿用 consolidation-20261011 验收记录的结构），并在最终回复中给出：
- 提交列表，以及每个提交改动的路径；
- 行为与约定变化，按 design.md §5 的区域逐项说明；
- 实际运行的命令与结果，区分静态检查、Electron 实际运行和用户接受（not_run）；
- 未运行项及原因（live、packaged、签名）；
- 与设计的偏差及理由（没有就写「无」）；
- 调整与新增的 E2E 清单；
- lint / 格式失败数与基线的对比。
````

## 3. 说明

- **为什么用 `--agents` 而不是 `.claude/agents/`**：不在仓库里新增工具配置文件，符合 AGENTS.md「工具专用入口只引用共享规则」；两个子代理只服务于这次实施。
- **为什么写明模型 ID**：`claude-opus-5-5` 与 `claude-sonnet-5-5` 是完整模型名，不随别名指向的变化而改变。
- **effort 优先级**：子代理定义里的 `effort` 会被环境变量 `CLAUDE_CODE_EFFORT_LEVEL` 覆盖，也会被派发时的 `effort` 参数覆盖，所以启动步骤里 unset 了该变量，prompt 里也要求主代理派发时不传 `model` 和 `effort`。
- **参考**：[Claude Code 子代理](https://code.claude.com/docs/en/sub-agents)、[模型与 effort 配置](https://code.claude.com/docs/en/model-config)。
