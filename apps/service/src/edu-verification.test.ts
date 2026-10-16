import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { EduVerificationService } from './edu-verification';
import { MaintenanceGate } from './maintenance-gate';
import { ASSESSMENT_PREFIX, parseRequest, parseResponse, strictJson } from './edu-assessment';
import { ProviderConfigSchema, providerArgs, createProviderRunner, loadProviderConfig } from './edu-provider';
import type { EduVerificationStatus, EduVerificationLease } from '@wsl/protocol';
import type { AppService, AppSnapshot } from './app-service';
const source = 'a'.repeat(64);
const config = {
  schemaVersion: 1 as const,
  host: 'example.invalid',
  user: 'provider',
  identityFile: '/private/key',
  hostKeyAlias: 'provider.test',
  knownHostsFile: '/private/known_hosts',
  pythonExecutable: '/immutable/.venv/bin/python',
  providerPath: '/immutable/deploy/provider.py',
};
const identity = { workspaceId: 'space', projectId: randomUUID(), environmentId: 'sandbox' as const, appInstanceId: randomUUID() };
const lease: EduVerificationLease = {
  schemaVersion: 1,
  sessionId: randomUUID(),
  identity,
  sourceSha256: source,
  expiresAtMs: Date.now() + 300000,
};
function audio() {
  const b = Buffer.alloc(6444);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(6400, 40);
  return b;
}
function request(l = lease) {
  const wav = audio();
  return {
    ...l,
    expiresAtMs: undefined,
    requestId: randomUUID(),
    submissionId: randomUUID(),
    audioSha256: createHash('sha256').update(wav).digest('hex'),
    reference: 'apple',
    audioBase64: wav.toString('base64'),
  };
}
const frame = (r = request()) => ASSESSMENT_PREFIX + JSON.stringify(r) + '\n';
function response(r: ReturnType<typeof request>, changes = {}) {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      event: 'edu-assessment-result',
      sessionId: r.sessionId,
      requestId: r.requestId,
      audioSha256: r.audioSha256,
      ok: true,
      result: {
        provider: 'azure',
        score: 91,
        accuracy_score: 91,
        rejected: false,
        transcript: 'apple',
        words: [{ word: 'apple', error_type: 'None', accuracy_score: 91 }],
        pronunciation_score: 91,
      },
      ...changes,
    }) + '\n',
  );
}
function fixture(
  options: {
    now?: () => number;
    drain?: () => Promise<void>;
    loadConfig?: () => Promise<typeof config>;
    fetch?: typeof fetch;
    onStatus?: (status: EduVerificationStatus) => void;
  } = {},
) {
  let snapshot = {
    ...identity,
    sourceSha256: source,
    profile: { projectKind: 'edu-web' },
    state: 'running',
    url: null,
    cleanupConfirmed: false,
  } as AppSnapshot;
  let callbacks: Parameters<AppService['start']>[1];
  const writes: string[] = [];
  let closes = 0;
  const starts: string[] = [];
  const apps = {
    restore: vi.fn(async () => structuredClone(snapshot)),
    export: vi.fn(async () => {
      return {} as Awaited<ReturnType<AppService['export']>>;
    }),
    stop: vi.fn(async () => {
      snapshot = { ...snapshot, state: 'stopped', cleanupConfirmed: true, url: null };
      return snapshot;
    }),
    start: vi.fn(async (_key: unknown, verification: Parameters<AppService['start']>[1], reserved?: string) => {
      callbacks = verification;
      snapshot = {
        ...snapshot,
        state: 'running',
        appInstanceId: verification?.lease.identity.appInstanceId ?? reserved ?? randomUUID(),
        cleanupConfirmed: false,
      };
      starts.push(snapshot.appInstanceId!);
      return snapshot;
    }),
    writeVerification: vi.fn((_key: unknown, _session: string, data: string) => writes.push(data)),
    closeVerificationInput: vi.fn(() => {
      closes++;
    }),
  };
  const gate = new MaintenanceGate();
  const runner = vi.fn(async (_config: unknown, input: string, _signal: AbortSignal): Promise<Buffer> => response(JSON.parse(input)));
  const service = new EduVerificationService(apps as unknown as AppService, gate, options.drain ?? (async () => undefined), {
    loadConfig: options.loadConfig ?? (async () => config),
    fetch: options.fetch,
    runner,
    now: options.now,
    onStatus: options.onStatus,
  });
  const begin = () =>
    service.begin({
      workspaceId: identity.workspaceId,
      projectId: identity.projectId,
      appInstanceId: identity.appInstanceId,
      sourceSha256: source,
    });
  const emit = (l: EduVerificationLease, r = request(l)) => callbacks!.request(frame(r));
  return {
    service,
    gate,
    apps,
    begin,
    emit,
    writes,
    runner,
    starts,
    get closes() {
      return closes;
    },
  };
}
describe('strict pronunciation framing', () => {
  it('accepts canonical request/result and preserves association only', () => {
    const r = request();
    expect(parseRequest(frame(r), lease).audioSha256).toBe(r.audioSha256);
    expect(JSON.parse(parseResponse(response(r), parseRequest(frame(r), lease))).result.score).toBe(91);
  });
  it.each(['{"a":1,"a":2}', '{"a":{"b":1,"b":2}}', '{"a":NaN}'])('rejects ambiguous JSON %s', (raw) =>
    expect(() => strictJson(raw)).toThrow(),
  );
  it.each(['sessionId', 'sourceSha256', 'audioSha256', 'identity', 'extra', 'audioBase64'])('rejects invalid %s', (key) => {
    const r = { ...request(), [key]: key === 'identity' ? { ...identity, appInstanceId: randomUUID() } : 'invalid' };
    expect(() => parseRequest(frame(r), lease)).toThrow();
  });
  it('rejects wrong WAV format with matching digest', () => {
    const wav = audio();
    wav.writeUInt32LE(44100, 24);
    const r = { ...request(), audioBase64: wav.toString('base64'), audioSha256: createHash('sha256').update(wav).digest('hex') };
    expect(() => parseRequest(frame(r), lease)).toThrow();
  });
  it.each([
    { requestId: randomUUID() },

    { ok: true, result: { provider: 'fixture' } },
    { ok: true, allowed: true },
    { result: { provider: 'azure', score: Infinity } },
  ])('rejects malicious normalized result', (change) => {
    const r = request();
    expect(() => parseResponse(response(r, change), parseRequest(frame(r), lease))).toThrow();
  });
  it('bounds both independent frame budgets', () => {
    expect(() => parseRequest(ASSESSMENT_PREFIX + ' '.repeat(1500000) + '\n', lease)).toThrow();
    expect(() => parseResponse(Buffer.alloc(65537), parseRequest(frame(), lease))).toThrow();
  });
  it('builds only fixed SSH command flags and private optional interface', () => {
    const args = providerArgs({ ...config, bindInterface: 'en9' });
    expect(args).toContain('/dev/null');
    expect(args).toContain('StrictHostKeyChecking=yes');
    expect(args).toContain('BindInterface=en9');
    expect(args.at(-1)).toBe("'/immutable/.venv/bin/python' -B '/immutable/deploy/provider.py'");
    expect(() => ProviderConfigSchema.parse({ ...config, providerPath: '/tmp/x;echo secret' })).toThrow();
    expect(() => ProviderConfigSchema.parse({ ...config, flags: [] })).toThrow();
  });
});
describe('verification ownership and maintenance admission', () => {
  it('locks synchronously, revokes pending epochs, and restores a distinct default process', async () => {
    let release!: () => void;
    const f = fixture({
      drain: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const pending = f.gate.admission();
    const begun = f.begin();
    expect(f.gate.isLocked()).toBe(true);
    expect(() => pending()).toThrow();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    const status = await begun;
    const target = { ...status.lease.identity, sessionId: status.lease.sessionId };
    expect(status.phase).toBe('active');
    expect(() => f.service.status({ ...target, sessionId: randomUUID() })).toThrow();
    const ended = await f.service.end(target);
    expect(ended.phase).toBe('ended');
    expect(f.closes).toBe(1);
    expect(f.starts).toHaveLength(2);
    expect(f.starts[0]).not.toBe(f.starts[1]);
    expect(f.gate.isLocked()).toBe(false);
    expect(() => pending()).toThrow();
  });
  it('dispatches twice and cached app submissions never create extra bridge calls', async () => {
    const f = fixture();
    const s = await f.begin();
    f.emit(s.lease);
    await vi.waitFor(() => expect(f.writes).toHaveLength(1));
    f.emit(s.lease);
    await vi.waitFor(() => expect(f.writes).toHaveLength(2));
    f.emit(s.lease);
    await vi.waitFor(() => expect(f.apps.stop).toHaveBeenCalledTimes(2));
    expect(f.runner).toHaveBeenCalledTimes(2);
  });
  it('drops late success after revoke and waits for runner termination', async () => {
    const f = fixture();
    let finish!: (raw: Buffer) => void;
    let r!: ReturnType<typeof request>;
    f.runner.mockImplementation(async (_c, input) => {
      r = JSON.parse(input);
      return new Promise<Buffer>((resolve) => {
        finish = resolve;
      });
    });
    const s = await f.begin();
    f.emit(s.lease);
    const ending = f.service.end({ ...s.lease.identity, sessionId: s.lease.sessionId });
    expect(f.gate.isLocked()).toBe(true);
    finish(response(r));
    await ending;
    expect(f.writes).toHaveLength(0);
    expect(f.gate.isLocked()).toBe(false);
  });
  it('rejects actual source changes without leased startup', async () => {
    const f = fixture();
    f.apps.restore.mockImplementation(
      async () => ({ ...identity, sourceSha256: 'b'.repeat(64), profile: { projectKind: 'edu-web' }, state: 'running' }) as AppSnapshot,
    );
    await expect(f.begin()).rejects.toThrow('verification_source_or_instance_changed');
    expect(f.apps.start).not.toHaveBeenCalled();
    expect(f.gate.isLocked()).toBe(false);
    await f.service.shutdown();
  });
  it('retains the lock when owned cleanup is unconfirmed', async () => {
    const f = fixture();
    const s = await f.begin();
    f.apps.stop.mockResolvedValue({ ...identity, state: 'failed', cleanupConfirmed: false } as AppSnapshot);
    await expect(f.service.end({ ...s.lease.identity, sessionId: s.lease.sessionId })).rejects.toThrow();
    expect(f.gate.isLocked()).toBe(true);
  });
  it('never forwards mismatched or expired results', async () => {
    let now = 1000;
    const f = fixture({ now: () => now });
    f.runner.mockImplementation(async () => {
      now += 300001;
      return response(request());
    });
    const s = await f.begin();
    f.emit(s.lease);
    await vi.waitFor(() => expect(f.apps.stop).toHaveBeenCalledTimes(2));
    expect(f.writes).toHaveLength(0);
  });
});

describe('provider real child boundary without SSH', () => {
  it('writes one JSON line then EOF and discards untrusted stderr', async () => {
    let args: string[] = [];
    const runner = createProviderRunner((argv) => {
      args = argv;
      return spawn('python3', [
        '-u',
        '-c',
        "import sys,json; body=sys.stdin.read(); assert body.endswith('\\n') and body.count('\\n')==1; sys.stderr.write('SECRET_AUDIO_AND_KEY'); print(json.dumps({'ok':True,'seen':json.loads(body)['id']}))",
      ]);
    });
    expect((await runner(config, '{"id":1}\n', new AbortController().signal)).toString()).toBe('{"ok": true, "seen": 1}\n');
    expect(args).toContain('PermitLocalCommand=no');
  });
  it('waits for actual process close after cancellation', async () => {
    let pid: number | undefined;
    const runner = createProviderRunner(() => {
      const p = spawn('python3', ['-u', '-c', 'import time; time.sleep(60)']);
      pid = p.pid;
      return p;
    });
    const controller = new AbortController();
    const running = runner(config, '{}\n', controller.signal);
    controller.abort();
    await expect(running).rejects.toThrow('assessment_provider_revoked');
    expect(() => process.kill(pid!, 0)).toThrow();
  });
  it('bounds remote stdout and never exposes raw exception text', async () => {
    const runner = createProviderRunner(() =>
      spawn('python3', ['-u', '-c', "import sys; sys.stderr.write('SECRET_AUDIO_AND_KEY'); sys.stdout.write('x'*65537)"]),
    );
    await expect(runner(config, '{}\n', new AbortController().signal)).rejects.toThrow('assessment_provider_budget');
  });
  it('reads only a private absolute regular configuration file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'provider-config-'));
    try {
      const file = path.join(root, 'provider.json');
      await writeFile(file, JSON.stringify(config), { mode: 0o600 });
      expect(await loadProviderConfig(file)).toEqual(config);
      await symlink(file, path.join(root, 'link'));
      await expect(loadProviderConfig(path.join(root, 'link'))).rejects.toThrow();
      await expect(loadProviderConfig('relative')).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
describe('ownership failure and explicit stop', () => {
  it.each(['source', 'instance', 'config'])('does not stop any project on rejected %s', async (kind) => {
    const f = fixture(
      kind === 'config'
        ? {
            loadConfig: async () => {
              throw new Error('secret');
            },
          }
        : {},
    );
    if (kind !== 'config')
      f.apps.restore.mockImplementation(
        async () =>
          ({
            ...identity,
            sourceSha256: kind === 'source' ? 'b'.repeat(64) : source,
            appInstanceId: kind === 'instance' ? randomUUID() : identity.appInstanceId,
            profile: { projectKind: 'edu-web' },
            state: 'running',
          }) as AppSnapshot,
      );
    await expect(f.begin()).rejects.toThrow(kind === 'config' ? 'verification_begin_failed' : 'verification_source_or_instance_changed');
    expect(f.apps.stop).not.toHaveBeenCalled();
    expect(f.apps.start).not.toHaveBeenCalled();
    expect(f.gate.isLocked()).toBe(false);
    await f.service.shutdown();
    expect(f.apps.stop).not.toHaveBeenCalled();
  });
  it('app.stop only revokes and leaves stopped until explicit AI0 restoration', async () => {
    const f = fixture();
    const s = await f.begin();
    expect(await f.service.stopCurrent(identity)).toBe(true);
    expect(f.starts).toHaveLength(1);
    expect(f.service.status({ ...s.lease.identity, sessionId: s.lease.sessionId }).phase).toBe('revoked');
    expect(f.gate.isLocked()).toBe(true);
    await f.service.end({ ...s.lease.identity, sessionId: s.lease.sessionId });
    expect(f.starts).toHaveLength(2);
    expect(f.gate.isLocked()).toBe(false);
  });
  it('URL timeouts never count as cleanup confirmation', async () => {
    const f = fixture({
      fetch: async () => {
        throw new DOMException('timeout', 'TimeoutError');
      },
    });
    const s = await f.begin();
    const original = f.apps.restore;
    original.mockImplementation(
      async () =>
        ({
          ...identity,
          appInstanceId: s.lease.identity.appInstanceId,
          url: 'http://127.0.0.1:49152',
          profile: { projectKind: 'edu-web' },
          state: 'running',
          cleanupConfirmed: false,
        }) as AppSnapshot,
    );
    await expect(f.service.end({ ...s.lease.identity, sessionId: s.lease.sessionId })).rejects.toThrow('verification_old_url_unconfirmed');
    expect(f.gate.isLocked()).toBe(true);
  });
});

it('actual begin lease roundtrips Python-ordered wire identity before dispatch', async () => {
  const f = fixture();
  const status = await f.begin();
  const r = request(status.lease);
  const raw = execFileSync(
    'python3',
    [
      '-c',
      "import sys,json; r=json.load(sys.stdin); i=r['identity']; r['identity']={k:i[k] for k in ('workspaceId','environmentId','projectId','appInstanceId')}; print('WSL_EDU_ASSESSMENT_REQUEST:'+json.dumps(r,separators=(',',':')))",
    ],
    { input: JSON.stringify(r) },
  ).toString();
  expect(parseRequest(raw, status.lease).identity.appInstanceId).toBe(status.lease.identity.appInstanceId);
  f.emit(status.lease, JSON.parse(raw.slice(ASSESSMENT_PREFIX.length)));
  await vi.waitFor(() => expect(f.writes).toHaveLength(1));
  await f.service.end({ ...status.lease.identity, sessionId: status.lease.sessionId });
});
it('cancels preparation before ownership without stopping the original project', async () => {
  let release!: () => void;
  const f = fixture({
    drain: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  });
  const begun = f.begin();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  // The trusted status event supplies this target during preparation.
  const current = (f.service as unknown as { current: { lease: EduVerificationLease } }).current;
  const end = f.service.end({ ...current.lease.identity, sessionId: current.lease.sessionId });
  release();
  await expect(begun).rejects.toThrow();
  await end;
  expect(f.apps.stop).not.toHaveBeenCalled();
  expect(f.gate.isLocked()).toBe(false);
});

it('provider deadline aborts without forwarding a late result or consuming retries', async () => {
  const observed: EduVerificationStatus[] = [];
  const f = fixture({ onStatus: (status) => observed.push(status) });
  const status = await f.begin();
  f.runner.mockImplementation(
    async (_config, _input, signal) =>
      new Promise<Buffer>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('SECRET_TIMEOUT')), { once: true }),
      ),
  );
  vi.useFakeTimers();
  try {
    f.emit(status.lease);
    await vi.advanceTimersByTimeAsync(45001);
    expect(observed.some((s) => s.phase === 'failed' && s.error === 'verification_provider_timeout')).toBe(true);
    expect(f.writes).toHaveLength(0);
    expect(f.runner).toHaveBeenCalledTimes(1);
    expect(f.apps.stop).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
    await f.service.shutdown();
  }
});
it('failed coding/terminal drain retains a visible lock without stopping any app', async () => {
  const f = fixture({
    drain: async () => {
      throw new Error('cleanup unconfirmed');
    },
  });
  await expect(f.begin()).rejects.toThrow('verification_drain_unconfirmed');
  expect(f.gate.isLocked()).toBe(true);
  expect(f.apps.stop).not.toHaveBeenCalled();
  await f.service.shutdown();
  expect(f.apps.stop).not.toHaveBeenCalled();
});
it('valid provider failures are sanitized and an explicit second call stays within budget', async () => {
  const f = fixture();
  f.runner.mockImplementation(async (_config, input) => {
    const r = JSON.parse(input);
    return Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        event: 'edu-assessment-result',
        sessionId: r.sessionId,
        requestId: r.requestId,
        audioSha256: r.audioSha256,
        ok: false,
        error: { code: 'provider_failed', message: 'UNTRUSTED_EXCEPTION' },
      }) + '\n',
    );
  });
  const s = await f.begin();
  f.emit(s.lease);
  await vi.waitFor(() => expect(f.writes).toHaveLength(1));
  expect(f.writes[0]).not.toContain('UNTRUSTED_EXCEPTION');
  f.emit(s.lease);
  await vi.waitFor(() => expect(f.writes).toHaveLength(2));
  await f.service.end({ ...s.lease.identity, sessionId: s.lease.sessionId });
});
it('untrusted runner error text cannot invent a provider timeout', async () => {
  const observed: EduVerificationStatus[] = [];
  const f = fixture({ onStatus: (s) => observed.push(s) });
  f.runner.mockRejectedValue(new Error('verification_provider_timeout SECRET'));
  const s = await f.begin();
  f.emit(s.lease);
  await vi.waitFor(() => expect(f.apps.stop).toHaveBeenCalledTimes(2));
  expect(observed.some((s) => s.phase === 'failed' && s.error === 'verification_provider_failed')).toBe(true);
  expect(observed.some((s) => s.error === 'verification_provider_timeout')).toBe(false);
  expect(f.writes).toHaveLength(0);
  expect(f.runner).toHaveBeenCalledTimes(1);
  await f.service.shutdown();
});
it.each([255000, 288000])('natural lease expiry retains its reason at request timer boundary %d', async (elapsed) => {
  vi.useFakeTimers();
  const observed: EduVerificationStatus[] = [];
  const f = fixture({ onStatus: (s) => observed.push(s) });
  try {
    const s = await f.begin();
    await vi.advanceTimersByTimeAsync(elapsed);
    f.runner.mockImplementation(
      async (_c, _input, signal) =>
        new Promise<Buffer>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('SECRET')), { once: true })),
    );
    f.emit(s.lease);
    await vi.advanceTimersByTimeAsync(300001 - elapsed);
    expect(observed.some((s) => s.phase === 'failed' && s.error === 'verification_expired')).toBe(true);
    expect(observed.some((s) => s.error === 'verification_provider_timeout' || s.error === 'verification_provider_failed')).toBe(false);
    expect(f.writes).toHaveLength(0);
    expect(f.runner).toHaveBeenCalledTimes(1);
    expect(f.apps.stop).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
    await f.service.shutdown();
  }
});
it('explicit cancellation never gets reclassified when its old timer would fire', async () => {
  const observed: EduVerificationStatus[] = [];
  const f = fixture({ onStatus: (s) => observed.push(s) });
  const s = await f.begin();
  f.runner.mockImplementation(
    async (_c, _input, signal) =>
      new Promise<Buffer>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('SECRET')), { once: true })),
  );
  vi.useFakeTimers();
  try {
    f.emit(s.lease);
    await f.service.end({ ...s.lease.identity, sessionId: s.lease.sessionId });
    await vi.advanceTimersByTimeAsync(45001);
    expect(observed.some((s) => s.phase === 'failed')).toBe(false);
    expect(f.writes).toHaveLength(0);
    expect(f.runner).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
    await f.service.shutdown();
  }
});
it('deadline marks timeout only after late runner settlement and never forwards success', async () => {
  const observed: EduVerificationStatus[] = [];
  const f = fixture({ onStatus: (s) => observed.push(s) });
  const s = await f.begin();
  let finish!: (value: Buffer) => void;
  let r!: ReturnType<typeof request>;
  f.runner.mockImplementation(async (_c, input) => {
    r = JSON.parse(input);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  vi.useFakeTimers();
  try {
    f.emit(s.lease);
    await vi.advanceTimersByTimeAsync(45001);
    expect(f.apps.stop).toHaveBeenCalledTimes(1);
    expect(f.writes).toHaveLength(0);
    finish(response(r));
    await vi.advanceTimersByTimeAsync(0);
    expect(observed.some((s) => s.phase === 'failed' && s.error === 'verification_provider_timeout')).toBe(true);
    expect(f.writes).toHaveLength(0);
    expect(f.apps.stop).toHaveBeenCalledTimes(2);
    expect(f.runner).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
    await f.service.shutdown();
  }
});
