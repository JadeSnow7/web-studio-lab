/**
 * 演示运行记录。
 *
 * 这些记录只用于检查界面如何呈现运行、取消、失败、无法判断、待审阅、接受、要求修改与无模型复验。
 * 它们是写死在仓库里的静态数据（origin = 'demo'），不是任何真实进程、模型调用或固定验收的结果，
 * 不能作为用例通过的证据。真实记录将由执行服务（T04）以 origin = 'live' 产生。
 */
import { DEFAULT_BUDGET, type Attempt, type Check, type CheckResult, type RunRecord, type RunStatus } from '@wsl/protocol';

export interface DemoScenario {
  runId: string;
  title: string;
  summary: string;
}

const T0 = Date.parse('2026-10-06T09:40:00+08:00');
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

const C1_DIFF = `diff --git a/src/db/schema.ts b/src/db/schema.ts
--- a/src/db/schema.ts
+++ b/src/db/schema.ts
@@ -8,6 +8,9 @@ export const tasks = pgTable('tasks', {
   title: text('title').notNull(),
   status: text('status').notNull(),
   ownerId: text('owner_id').notNull(),
+  priority: text('priority', { enum: ['low', 'medium', 'high'] })
+    .notNull()
+    .default('medium'),
   dueDate: date('due_date'),
 });
diff --git a/drizzle/0004_task_priority.sql b/drizzle/0004_task_priority.sql
new file mode 100644
--- /dev/null
+++ b/drizzle/0004_task_priority.sql
@@ -0,0 +1 @@
+ALTER TABLE "tasks" ADD COLUMN "priority" text DEFAULT 'medium' NOT NULL;
diff --git a/src/web/TaskForm.tsx b/src/web/TaskForm.tsx
--- a/src/web/TaskForm.tsx
+++ b/src/web/TaskForm.tsx
@@ -21,6 +21,14 @@ export function TaskForm({ task, onSave }: TaskFormProps) {
       <Input label="标题" {...register('title')} />
+      <Select label="优先级" {...register('priority')}>
+        <option value="low">低</option>
+        <option value="medium">中</option>
+        <option value="high">高</option>
+      </Select>
       <Button type="submit">保存</Button>`;

// 失败示例：只在界面上隐藏了按钮，服务端没有收紧，所以固定验收的 c2-deny 不通过。
const C2_DIFF = `diff --git a/src/web/TaskEdit.tsx b/src/web/TaskEdit.tsx
--- a/src/web/TaskEdit.tsx
+++ b/src/web/TaskEdit.tsx
@@ -12,7 +12,12 @@ export function TaskEdit({ task, viewer }: TaskEditProps) {
-  return <Button onClick={openEditor}>编辑任务</Button>;
+  if (task.ownerId !== viewer.id) {
+    return null;
+  }
+  return <Button onClick={openEditor}>编辑任务</Button>;`;

const C3_DIFF = `diff --git a/src/web/TaskList.tsx b/src/web/TaskList.tsx
--- a/src/web/TaskList.tsx
+++ b/src/web/TaskList.tsx
@@ -17,7 +17,7 @@ export function TaskList({ tasks }: TaskListProps) {
-          <td>{formatDate(task.deadline)}</td>
+          <td>{formatDate(task.dueDate)}</td>`;

function check(id: string, label: string, runner: Check['runner'], result: CheckResult, detail: string | null = null): Check {
  return { id, label, runner, result, detail };
}

const C1_FILES: Attempt['files'] = [
  { path: 'src/db/schema.ts', change: 'modified', additions: 3, deletions: 0 },
  { path: 'drizzle/0004_task_priority.sql', change: 'added', additions: 1, deletions: 0 },
  { path: 'src/web/TaskForm.tsx', change: 'modified', additions: 5, deletions: 0 },
];

function c1Checks(results: [CheckResult, CheckResult, CheckResult, CheckResult], detail: string | null = null): Check[] {
  return [
    check('c1-baseline', '初态下目标问题能被检出（对照）', 'api', results[0]),
    check('c1-save', 'priority 可编辑保存，API 返回一致', 'playwright', results[1]),
    check('c1-migrate', '旧记录迁移后可读，默认 medium', 'api', results[2]),
    check('c1-restart', '停止 API 并冷启动后值仍保留（不重新 seed）', 'api', results[3], detail),
  ];
}

function events(list: Array<[number, string, string]>): RunRecord['events'] {
  return list.map(([seconds, type, detail], index) => ({ seq: index + 1, timestamp: at(seconds), type, detail }));
}

function base(runId: string, status: RunStatus, overrides: Partial<RunRecord>): RunRecord {
  return {
    runId,
    origin: 'demo',
    mode: 'online',
    caseId: 'c1',
    taskRef: { taskId: 'demo-task', version: 1 },
    harness: { name: 'Codex CLI', version: null, model: null },
    budget: { ...DEFAULT_BUDGET },
    status,
    statusReason: null,
    startedAt: at(0),
    endedAt: null,
    sourceState: null,
    attempts: [],
    processes: [],
    events: [],
    diff: '',
    review: { state: 'not_ready' },
    ...overrides,
  };
}

const C1_COMMON_EVENTS: Array<[number, string, string]> = [
  [0, 'task.confirmed', '任务 v1 · C1 · 现场 task.html?id=1'],
  [1, 'run.started', 'online · 预算 3 次 attempt / 15 分钟'],
  [2, 'attempt.started', 'attempt 1'],
  [40, 'agent.event', 'Codex 开始修改生成副本'],
  [212, 'files.changed', '3 个文件'],
  [214, 'command.started', 'pnpm db:migrate'],
  [220, 'command.finished', 'pnpm db:migrate · exit 0'],
  [222, 'command.started', 'pnpm app:dev'],
  [251, 'app.ready', 'API 127.0.0.1:4310 · Web 127.0.0.1:5173'],
];

const passedAttempts: Attempt[] = [
  {
    attemptId: 'demo-a1',
    index: 1,
    stage: 'accepting',
    outcome: 'failed',
    reason: '冷启动后 priority 回到默认值，持久化未生效',
    startedAt: at(2),
    endedAt: at(300),
    files: C1_FILES.slice(0, 1).concat(C1_FILES.slice(2)),
    checks: c1Checks(['pass', 'pass', 'pass', 'fail'], '重启后读取到 medium，期望 high'),
  },
  {
    attemptId: 'demo-a2',
    index: 2,
    stage: 'accepting',
    outcome: 'passed',
    reason: null,
    startedAt: at(301),
    endedAt: at(522),
    files: C1_FILES,
    checks: c1Checks(['pass', 'pass', 'pass', 'pass']),
  },
];

const passedBase = (runId: string, review: RunRecord['review']): RunRecord =>
  base(runId, 'passed', {
    statusReason: 'attempt 2 通过全部固定验收',
    endedAt: at(530),
    sourceState: { baseCommit: 'demo-base-0000000', diffHash: 'sha256:demo-7d41e0' },
    attempts: passedAttempts,
    processes: [
      { name: 'App API', pgid: 48302, state: 'exited' },
      { name: '前端 dev server', pgid: 48305, state: 'exited' },
    ],
    events: events([
      ...C1_COMMON_EVENTS,
      [300, 'acceptance.result', 'attempt 1 · 3/4 通过 · 冷启动后值丢失'],
      [301, 'attempt.started', 'attempt 2 · 附带 attempt 1 失败证据'],
      [470, 'files.changed', '3 个文件'],
      [500, 'app.ready', 'API 127.0.0.1:4310 · Web 127.0.0.1:5173'],
      [522, 'acceptance.result', 'attempt 2 · 4/4 通过'],
      [530, 'run.finished', 'passed · 等待开发者审阅'],
    ]),
    diff: C1_DIFF,
    review,
  });

export const DEMO_RUNS: readonly RunRecord[] = [
  base('demo-run-running', 'running', {
    statusReason: '固定验收进行中',
    attempts: [
      {
        attemptId: 'demo-a1',
        index: 1,
        stage: 'accepting',
        outcome: 'running',
        reason: null,
        startedAt: at(2),
        endedAt: null,
        files: C1_FILES,
        checks: c1Checks(['pass', 'pass', 'running', 'pending']),
      },
    ],
    processes: [
      { name: 'App API', pgid: 48302, state: 'running' },
      { name: '前端 dev server', pgid: 48305, state: 'running' },
      { name: '验收 Playwright', pgid: 48340, state: 'running' },
    ],
    events: events([...C1_COMMON_EVENTS, [262, 'acceptance.result', 'c1-save · pass']]),
    diff: C1_DIFF,
  }),
  base('demo-run-cancelling', 'cancelling', {
    statusReason: '已向 3 个进程组发送 SIGTERM，等待退出（1/3 已退出）',
    attempts: [
      {
        attemptId: 'demo-a1',
        index: 1,
        stage: 'accepting',
        outcome: 'running',
        reason: null,
        startedAt: at(2),
        endedAt: null,
        files: C1_FILES,
        checks: c1Checks(['pass', 'running', 'pending', 'pending']),
      },
    ],
    processes: [
      { name: 'App API', pgid: 48302, state: 'exited' },
      { name: '前端 dev server', pgid: 48305, state: 'term_sent' },
      { name: '验收 Playwright', pgid: 48340, state: 'term_sent' },
    ],
    events: events([
      ...C1_COMMON_EVENTS,
      [270, 'run.cancel_requested', '开发者取消'],
      [270, 'process.signal', 'SIGTERM → 3 个进程组'],
      [271, 'process.exited', 'App API · code 143'],
    ]),
    diff: C1_DIFF,
  }),
  base('demo-run-cancelled', 'cancelled', {
    statusReason: '开发者取消；3 个进程组均已退出，端口已释放',
    endedAt: at(276),
    attempts: [
      {
        attemptId: 'demo-a1',
        index: 1,
        stage: 'accepting',
        outcome: 'cancelled',
        reason: '开发者取消',
        startedAt: at(2),
        endedAt: at(276),
        files: C1_FILES,
        checks: c1Checks(['pass', 'not_run', 'not_run', 'not_run']),
      },
    ],
    processes: [
      { name: 'App API', pgid: 48302, state: 'exited' },
      { name: '前端 dev server', pgid: 48305, state: 'exited' },
      { name: '验收 Playwright', pgid: 48340, state: 'exited' },
    ],
    events: events([
      ...C1_COMMON_EVENTS,
      [270, 'run.cancel_requested', '开发者取消'],
      [270, 'process.signal', 'SIGTERM → 3 个进程组'],
      [271, 'process.exited', 'App API · code 143'],
      [273, 'process.exited', '前端 dev server · code 143'],
      [276, 'process.exited', '验收 Playwright · code 143'],
      [276, 'run.finished', 'cancelled'],
    ]),
    diff: C1_DIFF,
  }),
  base('demo-run-failed', 'failed', {
    caseId: 'c2',
    statusReason: '3 次 attempt 均未通过固定验收，预算用尽',
    endedAt: at(760),
    attempts: [1, 2, 3].map((index) => ({
      attemptId: `demo-a${index}`,
      index,
      stage: 'accepting' as const,
      outcome: 'failed' as const,
      reason: 'B 直接请求 API 修改 A 的任务返回 200，数据被修改',
      startedAt: at((index - 1) * 250 + 2),
      endedAt: at(index * 250),
      files: [{ path: 'src/web/TaskEdit.tsx', change: 'modified' as const, additions: 4, deletions: 0 }],
      checks: [
        check('c2-baseline', '初态下目标问题能被检出（对照）', 'api', 'pass'),
        check('c2-owner', 'A 修改自己的任务成功', 'api', 'pass'),
        check('c2-deny', 'B 直接请求被拒绝且数据不变', 'api', 'fail', '期望 403，实际 200；只隐藏了按钮'),
        check('c2-ui', 'UI 错误提示与服务端一致', 'playwright', 'pass'),
      ],
    })),
    events: events([
      [0, 'task.confirmed', '任务 v1 · C2'],
      [1, 'run.started', 'online · 预算 3 次 attempt / 15 分钟'],
      [250, 'acceptance.result', 'attempt 1 · c2-deny fail'],
      [500, 'acceptance.result', 'attempt 2 · c2-deny fail'],
      [750, 'acceptance.result', 'attempt 3 · c2-deny fail'],
      [760, 'run.finished', 'failed · 预算用尽'],
    ]),
    diff: C2_DIFF,
  }),
  base('demo-run-inconclusive', 'inconclusive', {
    caseId: 'c3',
    statusReason: '工具故障：验收浏览器无法启动，无法判断业务结果（不计为验收失败）',
    endedAt: at(330),
    attempts: [
      {
        attemptId: 'demo-a1',
        index: 1,
        stage: 'accepting',
        outcome: 'inconclusive',
        reason: 'Playwright Chromium 启动失败',
        startedAt: at(2),
        endedAt: at(330),
        files: [{ path: 'src/web/TaskList.tsx', change: 'modified', additions: 1, deletions: 1 }],
        checks: [
          check('c3-types', 'schema / 类型检查通过', 'service', 'pass'),
          check('c3-api', '实际提交与 API 响应使用 dueDate', 'api', 'pass'),
          check('c3-ui', '保存后 UI 正确展示截止日期', 'playwright', 'error', 'browserType.launch: Executable doesn’t exist（演示文本）'),
          check('c3-regression', '关键原流程无回归', 'playwright', 'not_run'),
        ],
      },
    ],
    events: events([
      [0, 'task.confirmed', '任务 v1 · C3'],
      [1, 'run.started', 'online'],
      [320, 'command.finished', 'playwright test · 启动失败'],
      [330, 'run.finished', 'inconclusive · tool-failure'],
    ]),
    diff: C3_DIFF,
  }),
  base('demo-run-timed-out', 'timed_out', {
    statusReason: '总时限 15 分钟用尽；所属进程已清理',
    endedAt: at(900),
    attempts: [
      { ...(passedAttempts[0] as Attempt) },
      {
        attemptId: 'demo-a2',
        index: 2,
        stage: 'agent',
        outcome: 'timed_out',
        reason: '到达时限时 Codex 仍在修改',
        startedAt: at(301),
        endedAt: at(900),
        files: [],
        checks: c1Checks(['not_run', 'not_run', 'not_run', 'not_run']),
      },
    ],
    events: events([...C1_COMMON_EVENTS, [301, 'attempt.started', 'attempt 2'], [900, 'run.finished', 'timed_out']]),
    diff: C1_DIFF,
  }),
  passedBase('demo-run-passed', { state: 'pending' }),
  passedBase('demo-run-accepted', {
    state: 'accepted',
    decidedAt: at(600),
    taskVersion: 1,
    sourceState: { baseCommit: 'demo-base-0000000', diffHash: 'sha256:demo-7d41e0' },
  }),
  passedBase('demo-run-changes', {
    state: 'changes_requested',
    decidedAt: at(610),
    taskVersion: 1,
    note: '优先级下拉需要显示中文说明，确认后生成任务 v2',
  }),
  base('demo-run-revalidate', 'passed', {
    mode: 'revalidate',
    statusReason: '无模型复验：未调用模型，从最终源码快照重新执行固定验收',
    endedAt: at(140),
    sourceState: { baseCommit: 'demo-base-0000000', diffHash: 'sha256:demo-7d41e0' },
    attempts: [
      {
        attemptId: 'demo-r1',
        index: 1,
        stage: 'accepting',
        outcome: 'passed',
        reason: null,
        startedAt: at(2),
        endedAt: at(140),
        files: [],
        checks: c1Checks(['pass', 'pass', 'pass', 'pass']),
      },
    ],
    events: events([
      [0, 'run.started', 'revalidate · 源码快照 sha256:demo-7d41e0'],
      [60, 'app.ready', 'API 127.0.0.1:4311 · Web 127.0.0.1:5174'],
      [138, 'acceptance.result', '4/4 通过'],
      [140, 'run.finished', 'passed'],
    ]),
  }),
];

export const DEMO_SCENARIOS: readonly DemoScenario[] = [
  { runId: 'demo-run-running', title: '运行中', summary: '固定验收进行到第 3 项' },
  { runId: 'demo-run-cancelling', title: '取消中', summary: '等待进程组退出' },
  { runId: 'demo-run-cancelled', title: '已取消', summary: '进程全部退出后才记为终态' },
  { runId: 'demo-run-failed', title: '失败', summary: '业务验收未通过，预算用尽' },
  { runId: 'demo-run-inconclusive', title: '无法判断', summary: '工具故障，不计为验收失败' },
  { runId: 'demo-run-timed-out', title: '超时', summary: '15 分钟时限用尽' },
  { runId: 'demo-run-passed', title: '成功待审阅', summary: '可接受结果或要求修改' },
  { runId: 'demo-run-accepted', title: '已接受', summary: '绑定任务版本与源码快照' },
  { runId: 'demo-run-changes', title: '要求修改', summary: '需要生成新的任务版本' },
  { runId: 'demo-run-revalidate', title: '无模型复验', summary: '未调用模型的新记录' },
];
