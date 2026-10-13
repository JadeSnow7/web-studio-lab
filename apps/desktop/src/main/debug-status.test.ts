import { linkSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DebugStatusSnapshotSchema,
  SetupSnapshotSchema,
  StatusTransitionSchema,
  WorkbenchSnapshotSchema,
  type ChatStatus,
  type SetupSnapshot,
  type StatusTransition,
  type WorkbenchSnapshot,
} from '@wsl/protocol';
import { DebugStatus, LOG_LIMIT_BYTES, TRANSITION_LIMIT, debugStatusEnabled, type DebugStatusOptions } from './debug-status';
import type { TrustedRenderer } from './ipc-guard';

/* ---------- 夹具：全部用协议 schema 解析 ---------- */

const HOME = '/Users/tester';
const ROOT = '/Users/tester/work';

const setup = (overrides: Record<string, unknown> = {}, config: Record<string, unknown> = {}): SetupSnapshot =>
  SetupSnapshotSchema.parse({
    schemaVersion: 1,
    stage: 'ready',
    busy: false,
    error: null,
    pendingLogin: null,
    modelCredentialsConfigured: true,
    modelConnectionVerified: false,
    config: { schemaVersion: 1, sbxBinary: null, sandbox: null, pythonBinary: '/usr/bin/python3', localRoot: null, ssh: null, ...config },
    restartRequired: false,
    ...overrides,
  });
const chat = (overrides: Partial<ChatStatus> = {}): ChatStatus => ({
  available: true,
  reason: null,
  version: '0.160.0',
  sandbox: 'sbx-1',
  cwd: '/work',
  ...overrides,
});
const terminal = (state: string, overrides: Record<string, unknown> = {}) => ({
  seq: 1,
  sessionId: 'pty-1',
  sandbox: 'sandbox-abc',
  cwd: '/work/project',
  state,
  output: 'SECRET-TERMINAL-OUTPUT',
  outputOffset: 0,
  cleanupPending: false,
  error: null,
  ...overrides,
});
const workbench = (seq: number, terminalState: Record<string, unknown> | null): WorkbenchSnapshot =>
  WorkbenchSnapshotSchema.parse({
    appInstanceId: 'app-inst-1',
    environments: [],
    storageError: null,
    activeWorkspaceId: 'ws',
    seq,
    workspaces: [
      {
        workspaceId: 'ws',
        name: 'ws',
        revision: 1,
        tabs: [],
        layout: { kind: 'pane', paneId: 'pane', tabId: null },
        activePaneId: 'pane',
        theme: 'light',
        resources: [
          {
            resourceId: 't1',
            kind: 'terminal',
            environmentId: 'local',
            title: 't1',
            url: null,
            instanceId: 't1-inst',
            generation: 1,
            preview: null,
            terminal: terminalState,
            unavailableReason: null,
          },
        ],
        sessions: [
          {
            sessionId: 's1',
            resourceId: 's1-res',
            title: 's1',
            draft: 'SECRET-DRAFT',
            conversation: null,
            context: null,
            contextTarget: null,
            taskTargetRef: null,
            contextApplicability: 'unknown',
            taskVersions: [],
          },
        ],
        runs: [],
      },
    ],
  });

/** 内存中的日志文件：记录每次写入的内容。 */
function memoryLog() {
  const writes: Array<{ path: string; data: string }> = [];
  const prepared: string[] = [];
  let total = 0;
  return {
    writes,
    prepared,
    // 内存日志：不触碰真实文件系统；真实文件的创建 / 拒绝规则见下方「真实文件」用例。
    io: {
      prepareLogFile: (path: string) => void prepared.push(path),
      writeLogFile: (path: string, data: string) => {
        writes.push({ path, data });
        total += Buffer.byteLength(data);
      },
    },
    lines: () =>
      writes.flatMap((write) => write.data.split('\n').filter(Boolean)).map((line) => JSON.parse(line) as Record<string, unknown>),
    bytes: () => total,
  };
}

function create(options: Partial<DebugStatusOptions> = {}) {
  let tick = 0;
  const emitted: StatusTransition[] = [];
  const errors: string[] = [];
  const debug = new DebugStatus({
    homeDir: HOME,
    now: () => new Date(Date.UTC(2026, 9, 11, 0, 0, tick++)),
    emit: (transition) => emitted.push(transition),
    reportError: (message) => errors.push(message),
    ...options,
  });
  return { debug, emitted, errors };
}

describe('启用判定', () => {
  const dev: TrustedRenderer = { kind: 'dev-server', origin: 'http://localhost:5173' };
  const file: TrustedRenderer = { kind: 'file', url: 'file:///app/renderer/index.html' };
  it('开发服务器默认启用', () => {
    expect(debugStatusEnabled(dev, {})).toBe(true);
  });
  it('build 产物与正式包（file 来源）默认关闭', () => {
    expect(debugStatusEnabled(file, {})).toBe(false);
    expect(debugStatusEnabled(file, { WSL_DEBUG_STATUS: '0' })).toBe(false);
    expect(debugStatusEnabled(file, { WSL_DEBUG_STATUS: 'true' })).toBe(false);
  });
  it('只有 WSL_DEBUG_STATUS=1 显式启用 file 来源', () => {
    expect(debugStatusEnabled(file, { WSL_DEBUG_STATUS: '1' })).toBe(true);
  });
});

describe('转换计算', () => {
  it('新增、变化、消失各产生一条转换，seq 单调递增，at 为 ISO 时间', () => {
    const { debug, emitted } = create();
    debug.onChat(chat());
    const first = debug.snapshot();
    // chat 事实新增（from 为 null）；固定的执行状态尚未输入，因此只有这一条。
    expect(first.transitions).toEqual([
      expect.objectContaining({
        key: 'chat:global:state',
        from: null,
        to: { phase: 'ok', kind: 'steady', label: '对话可用' },
      }),
    ]);

    debug.onChat(chat({ available: false, reason: '沙箱未启动' }));
    const changed = debug.snapshot().transitions.at(-1)!;
    expect(changed).toMatchObject({
      key: 'chat:global:state',
      from: { phase: 'ok', kind: 'steady', label: '对话可用' },
      to: { phase: 'failed', kind: 'problem', label: '对话不可用' },
    });

    debug.onSetup(setup({ error: { code: 'E', message: '失败' } }));
    expect(debug.snapshot().transitions.at(-1)).toMatchObject({ key: 'setup:global:error', from: null });
    debug.onSetup(setup());
    expect(debug.snapshot().transitions.at(-1)).toMatchObject({
      key: 'setup:global:error',
      from: { phase: 'failed', kind: 'problem', label: '环境安装出错' },
      to: null,
    });

    const { transitions } = debug.snapshot();
    expect(transitions.map((t) => t.seq)).toEqual([...transitions.keys()].map((i) => i + 1));
    for (const transition of transitions) {
      expect(StatusTransitionSchema.safeParse(transition).success).toBe(true);
      expect(new Date(transition.at).toISOString()).toBe(transition.at);
    }
    // 事件出口推送的与快照中的是同一批（已脱敏）转换。
    expect(emitted).toEqual(transitions);
  });

  it('只有 phase / kind / label 变化才产生转换；detail 与 raw 的变化不产生', () => {
    const { debug } = create();
    debug.onChat(chat({ version: '1' }));
    debug.onChat(chat({ version: '2', cwd: '/other' }));
    expect(debug.snapshot().transitions).toHaveLength(1);
    expect(debug.snapshot().facts[0]).toMatchObject({ detail: '2 · sbx-1 · /other' });
  });

  it('终端连接产生转换；同一应用实例内迟到的旧快照被忽略', () => {
    const { debug } = create();
    debug.onWorkbench(workbench(5, terminal('idle')));
    debug.onWorkbench(workbench(6, terminal('running')));
    expect(debug.snapshot().transitions.at(-1)).toMatchObject({
      key: 'terminal:t1:state',
      from: { phase: 'idle', kind: 'steady', label: '尚未连接' },
      to: { phase: 'ok', kind: 'steady', label: '已连接' },
    });
    const before = debug.snapshot().seq;
    debug.onWorkbench(workbench(4, terminal('failed')));
    expect(debug.snapshot().seq).toBe(before);
    expect(debug.snapshot().facts.find((fact) => fact.key === 'terminal:t1:state')?.label).toBe('已连接');
    expect(debug.snapshot().appInstanceId).toBe('app-inst-1');
  });

  it('环形缓冲只保留最近 500 条，seq 仍然连续递增', () => {
    const { debug } = create();
    for (let index = 0; index < 700; index += 1) debug.onChat(chat({ available: index % 2 === 0 }));
    const snapshot = debug.snapshot();
    expect(TRANSITION_LIMIT).toBe(500);
    expect(snapshot.transitions).toHaveLength(500);
    expect(snapshot.seq).toBe(700);
    expect(snapshot.transitions[0]!.seq).toBe(201);
    expect(snapshot.transitions.at(-1)!.seq).toBe(700);
  });

  it('快照通过协议 schema 校验，并在首个工作台快照到达前使用占位 appInstanceId', () => {
    const { debug } = create();
    debug.update({ setup: setup() });
    const snapshot = debug.snapshot();
    expect(DebugStatusSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.appInstanceId).toBe('unavailable');
  });

  it('投影失败只报告一次、不向调用方抛出，并保留上一份事实', () => {
    const { debug, errors } = create();
    debug.onChat(chat());
    expect(() => debug.onWorkbench({} as WorkbenchSnapshot)).not.toThrow();
    expect(() => debug.onWorkbench({} as WorkbenchSnapshot)).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(debug.snapshot().facts.map((fact) => fact.key)).toEqual(['chat:global:state']);
  });
});

describe('数据边界与脱敏', () => {
  it('事实与转换不含 PageCapture、终端输出、消息正文、草稿', () => {
    const { debug } = create();
    debug.onWorkbench(workbench(1, terminal('running')));
    const serialized = JSON.stringify(debug.snapshot());
    for (const secret of ['SECRET-TERMINAL-OUTPUT', 'SECRET-DRAFT', 'data:image', 'workspaces', 'screenshot'])
      expect(serialized, secret).not.toContain(secret);
  });

  it('快照、事件与 NDJSON 都经过脱敏：家目录、授权根、URL 查询串、凭据、SSH 身份', () => {
    const log = memoryLog();
    const { debug, emitted } = create({ logPath: '/tmp/status.ndjson', ...log.io });
    const config = {
      localRoot: ROOT,
      ssh: { host: 'ssh.example.test', port: 22, username: 'alice', hostKeySha256: 'a'.repeat(64), root: '/srv/data' },
    };
    debug.update({ setup: setup({}, config) });
    debug.startLog();
    debug.onChat(
      chat({
        available: false,
        reason: `读取 ${ROOT}/src 与 ${HOME}/.codex 失败 https://example.com/cb?token=QUERYSECRET#frag 凭据 sk-abcdefghijklmnopqrstuvwxyz 且 alice@ssh.example.test 拒绝`,
      }),
    );
    const everything = JSON.stringify(debug.snapshot()) + JSON.stringify(emitted) + log.writes.map((write) => write.data).join('');
    for (const secret of [HOME, 'QUERYSECRET', '#frag', 'sk-abcdefghijklmnopqrstuvwxyz', 'ssh.example.test', 'alice'])
      expect(everything, secret).not.toContain(secret);
    const detail = debug.snapshot().facts.find((fact) => fact.key === 'chat:global:state')!.detail!;
    expect(detail).toContain('src');
    expect(detail).toContain('~/.codex');
    expect(detail).toContain('https://example.com/cb');
    expect(detail).toContain('[redacted]');
    expect(detail).toContain('ssh:');
  });

  it('补充的开发环境授权根与 SSH 身份同样用于脱敏', () => {
    const { debug } = create({ extraRoots: ['/opt/dev-root'], extraSshIdentities: ['dev.host.test'] });
    debug.onChat(chat({ available: false, reason: '/opt/dev-root/a 与 dev.host.test 不可用' }));
    const detail = debug.snapshot().facts[0]!.detail!;
    expect(detail).not.toContain('/opt/dev-root');
    expect(detail).not.toContain('dev.host.test');
  });
});

describe('NDJSON（WSL_STATUS_LOG）', () => {
  it('首行为 snapshot 且只含事实，其后为 transition；准备文件一次，之后追加', () => {
    const log = memoryLog();
    const { debug } = create({ logPath: '/tmp/status.ndjson', ...log.io });
    debug.onWorkbench(workbench(1, terminal('idle')));
    debug.update({ setup: setup() });
    debug.startLog();
    debug.onWorkbench(workbench(2, terminal('running')));

    const lines = log.lines();
    expect(lines[0]).toMatchObject({ type: 'snapshot', appInstanceId: 'app-inst-1' });
    expect(Object.keys(lines[0]!).sort()).toEqual(['appInstanceId', 'facts', 'generatedAt', 'seq', 'type']);
    expect((lines[0]!['facts'] as Array<{ key: string }>).map((fact) => fact.key)).toContain('terminal:t1:state');
    expect(JSON.stringify(lines[0])).not.toContain('SECRET');
    expect(lines.slice(1)).toEqual([expect.objectContaining({ type: 'transition', key: 'terminal:t1:state' })]);
    expect(log.prepared).toEqual(['/tmp/status.ndjson']);
    expect(log.writes).toHaveLength(2);
    expect(log.writes.every((write) => write.path === '/tmp/status.ndjson')).toBe(true);
  });

  it('未设置路径、或未调用 startLog 时不写文件', () => {
    const log = memoryLog();
    const withoutPath = create({ ...log.io });
    withoutPath.debug.startLog();
    withoutPath.debug.onChat(chat());
    const notStarted = create({ logPath: '/tmp/x', ...log.io });
    notStarted.debug.onChat(chat());
    expect(log.writes).toEqual([]);
  });

  it('文件达到 5 MiB 时写一行 limit 后停止，不超过上限；内存中的转换与事件继续', () => {
    const log = memoryLog();
    const { debug, emitted } = create({ logPath: '/tmp/status.ndjson', ...log.io });
    debug.startLog();
    let updates = 0;
    while (log.bytes() < LOG_LIMIT_BYTES - 1024 && updates < 200_000) {
      debug.onChat(chat({ available: updates % 2 === 0 }));
      updates += 1;
    }
    // 继续触发，直到日志停止。
    for (let index = 0; index < 100; index += 1) debug.onChat(chat({ available: (updates + index) % 2 === 0 }));
    const lines = log.lines();
    expect(lines.at(-1)).toEqual({ type: 'limit' });
    expect(lines.filter((line) => line['type'] === 'limit')).toHaveLength(1);
    expect(log.bytes()).toBeLessThanOrEqual(LOG_LIMIT_BYTES);

    const writesAtStop = log.writes.length;
    const emittedAtStop = emitted.length;
    debug.onChat(chat({ available: false, reason: 'x' }));
    debug.onChat(chat({ available: true }));
    expect(log.writes).toHaveLength(writesAtStop);
    expect(emitted.length).toBeGreaterThan(emittedAtStop);
    expect(debug.snapshot().seq).toBeGreaterThan(updates);
  });

  it('写入失败只记录一次并停用，不影响应用与诊断数据', () => {
    let attempts = 0;
    const { debug, errors, emitted } = create({
      logPath: '/nonexistent/dir/status.ndjson',
      prepareLogFile: () => undefined,
      writeLogFile: () => {
        attempts += 1;
        throw new Error('EACCES');
      },
    });
    expect(() => debug.startLog()).not.toThrow();
    expect(() => {
      debug.onChat(chat());
      debug.onChat(chat({ available: false }));
      debug.onChat(chat({ available: true }));
    }).not.toThrow();
    expect(attempts).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('已停用');
    expect(emitted).toHaveLength(3);
    expect(debug.snapshot().transitions).toHaveLength(3);
  });
});

describe('推送失败', () => {
  it('emit 抛错不中断同批转换的 NDJSON，不记为投影失败，只报告一次，诊断数据继续更新', () => {
    const log = memoryLog();
    const { debug, errors } = create({
      logPath: '/tmp/status.ndjson',
      ...log.io,
      emit: () => {
        throw new Error('window destroyed');
      },
    });
    debug.startLog();
    // 同一批产生多条转换（chat 与 setup 错误一起出现）。
    expect(() => debug.update({ chat: chat(), setup: setup({ error: { code: 'E', message: '失败' } }) })).not.toThrow();
    expect(() => debug.onChat(chat({ available: false }))).not.toThrow();
    const logged = log.lines().filter((line) => line['type'] === 'transition');
    expect(logged.map((line) => line['key'])).toEqual(['chat:global:state', 'setup:global:error', 'chat:global:state']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('推送失败');
    expect(errors[0]).not.toContain('投影');
    expect(debug.snapshot().transitions).toHaveLength(3);
    // 之后的投影仍然正常（没有被误置为投影失败）。
    debug.onChat(chat());
    expect(debug.snapshot().transitions).toHaveLength(4);
    expect(errors).toHaveLength(1);
  });
});

describe('WSL_STATUS_LOG 真实文件', () => {
  const withDir = (run: (dir: string) => void) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wsl-status-log-'));
    try {
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('文件不存在时创建，首行为 snapshot，之后追加 transition', () =>
    withDir((dir) => {
      const file = path.join(dir, 'status.ndjson');
      const { debug, errors } = create({ logPath: file });
      debug.onChat(chat());
      debug.startLog();
      debug.onChat(chat({ available: false }));
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'snapshot' });
      expect(JSON.parse(lines[1]!)).toMatchObject({ type: 'transition', key: 'chat:global:state' });
      expect(errors).toEqual([]);
    }));

  it.each(['file', 'hardlink'])('启动后日志路径被 %s 替换时拒绝追加，保留两份文件', (replacement) =>
    withDir((dir) => {
      const file = path.join(dir, 'status.ndjson');
      const original = path.join(dir, 'original.ndjson');
      const target = path.join(dir, 'notes.txt');
      const content = '用户内容，不能追加诊断数据\n';
      const { debug, errors } = create({ logPath: file });
      debug.startLog();
      const snapshot = readFileSync(file, 'utf8');
      renameSync(file, original);
      if (replacement === 'hardlink') {
        writeFileSync(target, content);
        linkSync(target, file);
      } else writeFileSync(file, content);
      debug.onChat(chat());
      debug.onChat(chat({ available: false }));
      debug.startLog();
      expect(readFileSync(file, 'utf8')).toBe(content);
      if (replacement === 'hardlink') expect(readFileSync(target, 'utf8')).toBe(content);
      expect(readFileSync(original, 'utf8')).toBe(snapshot);
      expect(errors).toHaveLength(1);
      expect(debug.snapshot().transitions).toHaveLength(2);
    }),
  );

  it('日志新增硬链接后拒绝继续写入共享的文件', () =>
    withDir((dir) => {
      const file = path.join(dir, 'status.ndjson');
      const target = path.join(dir, 'shared.ndjson');
      const { debug, errors } = create({ logPath: file });
      debug.startLog();
      const snapshot = readFileSync(file, 'utf8');
      linkSync(file, target);
      debug.onChat(chat());
      expect(readFileSync(target, 'utf8')).toBe(snapshot);
      expect(errors).toHaveLength(1);
      expect(debug.snapshot().transitions).toHaveLength(1);
    }));

  it('日志内容被外部追加后停止写入，不把外部字节排除在上限之外', () =>
    withDir((dir) => {
      const file = path.join(dir, 'status.ndjson');
      const { debug, errors } = create({ logPath: file });
      debug.startLog();
      writeFileSync(file, '外部追加\n', { flag: 'a' });
      const changed = readFileSync(file, 'utf8');
      debug.onChat(chat());
      debug.onChat(chat({ available: false }));
      expect(readFileSync(file, 'utf8')).toBe(changed);
      expect(errors).toHaveLength(1);
      expect(debug.snapshot().transitions).toHaveLength(2);
    }));

  it('已有的非诊断文件不被改动：报告一次并停用 NDJSON', () =>
    withDir((dir) => {
      const file = path.join(dir, 'notes.txt');
      writeFileSync(file, '重要内容，不能被截断\n');
      const { debug, errors } = create({ logPath: file });
      debug.startLog();
      debug.onChat(chat());
      debug.onChat(chat({ available: false }));
      expect(readFileSync(file, 'utf8')).toBe('重要内容，不能被截断\n');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('已停用');
      expect(debug.snapshot().transitions).toHaveLength(2);
    }));

  it('符号链接一律拒绝，链接目标不被改动', () =>
    withDir((dir) => {
      const target = path.join(dir, 'target.ndjson');
      // 目标即使看起来像诊断日志也不能经符号链接写入。
      writeFileSync(target, '{"type":"snapshot","facts":[]}\n');
      const link = path.join(dir, 'link.ndjson');
      symlinkSync(target, link);
      const { debug, errors } = create({ logPath: link });
      debug.startLog();
      debug.onChat(chat());
      expect(readFileSync(target, 'utf8')).toBe('{"type":"snapshot","facts":[]}\n');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(errors).toHaveLength(1);
    }));

  it('悬空符号链接同样拒绝，不会在链接目标处创建文件', () =>
    withDir((dir) => {
      const target = path.join(dir, 'missing.ndjson');
      const link = path.join(dir, 'dangling.ndjson');
      symlinkSync(target, link);
      const { debug, errors } = create({ logPath: link });
      debug.startLog();
      expect(() => lstatSync(target)).toThrow();
      expect(errors).toHaveLength(1);
    }));

  it('空文件同样拒绝，不当作可重建的日志', () =>
    withDir((dir) => {
      const file = path.join(dir, 'status.ndjson');
      writeFileSync(file, '');
      const { debug, errors } = create({ logPath: file });
      debug.startLog();
      debug.onChat(chat());
      expect(readFileSync(file, 'utf8')).toBe('');
      expect(errors).toHaveLength(1);
    }));

  it('以 snapshot 前缀开头但不是诊断日志的文件同样拒绝，原字节不变', () =>
    withDir((dir) => {
      const file = path.join(dir, 'inventory.ndjson');
      const content = '{"type":"snapshot","system":"inventory","records":[{"sku":"A1","quantity":50}]}\n';
      writeFileSync(file, content);
      const { debug, errors } = create({ logPath: file });
      debug.startLog();
      debug.onChat(chat());
      debug.onChat(chat({ available: false }));
      expect(readFileSync(file, 'utf8')).toBe(content);
      expect(errors).toHaveLength(1);
      expect(debug.snapshot().transitions).toHaveLength(2);
    }));

  it('上次诊断留下的日志同样拒绝，旧内容原样保留', () =>
    withDir((dir) => {
      const file = path.join(dir, 'status.ndjson');
      const content = '{"type":"snapshot","facts":[]}\n{"type":"transition","key":"old"}\n';
      writeFileSync(file, content);
      const { debug, errors } = create({ logPath: file });
      debug.onChat(chat());
      debug.startLog();
      expect(readFileSync(file, 'utf8')).toBe(content);
      expect(errors).toHaveLength(1);
    }));

  it('路径被拒绝后，重复 startLog 与后续更新不再准备或写入文件', () => {
    let prepares = 0;
    let writes = 0;
    const { debug, errors } = create({
      logPath: '/tmp/existing.ndjson',
      prepareLogFile: () => {
        prepares += 1;
        throw new Error('EEXIST');
      },
      writeLogFile: () => {
        writes += 1;
      },
    });
    debug.startLog();
    debug.startLog();
    debug.onChat(chat());
    debug.onChat(chat({ available: false }));
    expect(prepares).toBe(1);
    expect(writes).toBe(0);
    expect(errors).toHaveLength(1);
    expect(debug.snapshot().transitions).toHaveLength(2);
  });
});

describe('事实更新通知（debug:facts-changed）', () => {
  it('新增事实与 detail / raw 变化每批通知一次；detail / raw 不产生转换、不增加 seq、不写 NDJSON', () => {
    const log = memoryLog();
    let notified = 0;
    const { debug } = create({ logPath: '/tmp/status.ndjson', ...log.io, emitFactsChanged: () => (notified += 1) });
    debug.startLog();
    debug.onChat(chat({ version: '1' }));
    expect(notified).toBe(1);
    const seqAfterAdd = debug.snapshot().seq;
    const writesAfterAdd = log.writes.length;

    debug.onChat(chat({ version: '2' }));
    expect(notified).toBe(2);
    expect(debug.snapshot().seq).toBe(seqAfterAdd);
    expect(log.writes).toHaveLength(writesAfterAdd);
    expect(debug.snapshot().facts.find((fact) => fact.key === 'chat:global:state')?.detail).toContain('2');

    debug.onWorkbench(workbench(1, terminal('running')));
    expect(notified).toBe(3);
    const seqAfterWorkbench = debug.snapshot().seq;
    const writesAfterWorkbench = log.writes.length;

    debug.onWorkbench(workbench(2, terminal('running', { outputOffset: 42 })));
    expect(notified).toBe(4);
    expect(debug.snapshot().seq).toBe(seqAfterWorkbench);
    expect(log.writes).toHaveLength(writesAfterWorkbench);
  });

  it('完全相同的投影不通知；仅 appInstanceId 变化也通知一次、不产生转换', () => {
    let notified = 0;
    const { debug } = create({ emitFactsChanged: () => (notified += 1) });
    debug.onChat(chat());
    debug.onChat(chat());
    expect(notified).toBe(1);

    debug.onWorkbench(workbench(1, null));
    expect(notified).toBe(2);
    const seqBefore = debug.snapshot().seq;
    debug.onWorkbench(workbench(2, null));
    expect(notified).toBe(2);
    expect(debug.snapshot().seq).toBe(seqBefore);

    const otherInstance = workbench(3, null);
    otherInstance.appInstanceId = 'app-inst-2';
    debug.onWorkbench(otherInstance);
    expect(notified).toBe(3);
    expect(debug.snapshot().seq).toBe(seqBefore);
    expect(debug.snapshot().appInstanceId).toBe('app-inst-2');
  });

  it('授权根变化只改变脱敏结果时也通知一次，不产生转换、seq 不变', () => {
    let notified = 0;
    const { debug } = create({ emitFactsChanged: () => (notified += 1) });
    debug.onChat(chat({ available: false, reason: '读取 /opt/private-root/a 失败' }));
    expect(notified).toBe(1);
    expect(debug.snapshot().facts.find((fact) => fact.key === 'chat:global:state')!.detail).toContain('/opt/private-root');
    const seqBefore = debug.snapshot().seq;
    const transitionsBefore = debug.snapshot().transitions.length;

    debug.onSetup(setup({}, { localRoot: '/opt/private-root' }));
    expect(notified).toBe(2);
    expect(debug.snapshot().seq).toBe(seqBefore);
    expect(debug.snapshot().transitions).toHaveLength(transitionsBefore);
    expect(debug.snapshot().facts.find((fact) => fact.key === 'chat:global:state')!.detail).not.toContain('/opt/private-root');
  });

  it('emitFactsChanged 抛错只报告一次，不打断事实更新、转换与 NDJSON', () => {
    const log = memoryLog();
    let calls = 0;
    const { debug, errors } = create({
      logPath: '/tmp/status.ndjson',
      ...log.io,
      emitFactsChanged: () => {
        calls += 1;
        throw new Error('window destroyed');
      },
    });
    debug.startLog();
    expect(() => {
      debug.onChat(chat());
      debug.onChat(chat({ version: '2' }));
      debug.onChat(chat({ available: false }));
    }).not.toThrow();
    expect(calls).toBe(3);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('通知失败');
    expect(debug.snapshot().transitions).toHaveLength(2);
    expect(log.lines().filter((line) => line['type'] === 'transition')).toHaveLength(2);
    expect(debug.snapshot().facts.find((fact) => fact.key === 'chat:global:state')?.phase).toBe('failed');
  });
});
