import { describe, expect, it, vi } from 'vitest';
import {
  comparableTrace,
  type AgentControlState,
  type AppAgentOperation,
  type AppAgentResult,
  type AppAuditRecord,
  type AppBridgeRequest,
  type AppControlResult,
  type AppScenarioTrace,
  type ObservationTurnScope,
} from '@wsl/protocol';
import { AppControl, jsonDiff, summarizeArgs, type AppControlContext, type AppControlPorts, type AppUiPort } from './app-control';
import { AppControlFailure } from './app-control-failure';

const REVISION = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const scope: ObservationTurnScope = { workspaceId: 'w', sessionId: 's', runId: 'run-1', sources: [] };
const manifest = {
  schemaVersion: 1,
  templateId: 'wsl-standard-app',
  templateVersion: '1.1.0',
  sourceRevision: REVISION,
  pages: [{ path: '/', source: 'src/App.tsx', testids: ['welcome-save'] }],
  routes: [{ method: 'GET', path: '/api/health' }],
  dataModel: [],
  commands: [{ name: 'health.refresh', description: 'x', inputSchema: { type: 'object' }, sources: ['src/App.tsx:1'] }],
  states: [{ name: 'welcome', sources: ['src/App.tsx:2'] }],
  testids: [{ testid: 'welcome-save', element: 'Button', source: 'src/App.tsx:3' }],
  checks: [],
};

function harness(overrides: Partial<AppControlContext> = {}) {
  let context: AppControlContext = {
    workspaceId: 'w',
    sessionId: 's',
    runId: 'run-1',
    allowsReset: false,
    app: { projectId: 'p', appInstanceId: 'app-1', state: 'running', url: 'http://127.0.0.1:1', cleanupConfirmed: false, error: null },
    browser: { resourceId: 'r', instanceId: 'i', generation: 1 },
    ...overrides,
  };
  let revision = { operationTrackingVersion: 1, currentRevision: REVISION, manifestRevision: REVISION, buildRevision: REVISION, manifest };
  let generation = 4;
  let welcome = 'Ready';
  let lease = true;
  const audit: AppAuditRecord[] = [];
  const evidence = new Map<string, string | Buffer>();
  const bridgeCalls: AppBridgeRequest[] = [];
  const acts: unknown[] = [];
  const agentOps: AppAgentOperation[] = [];
  let control: AgentControlState = { state: 'idle', runId: null, since: null, lastAction: null };
  let actGate: Promise<void> | null = null;
  let describeGate: Promise<void> | null = null;
  const released: string[] = [];
  const ui: AppUiPort = {
    identity: () => ({ documentGeneration: generation, url: 'http://127.0.0.1:1/', cdp: { state: 'attached' }, agentControl: control }),
    snapshot: async (appInstanceId) => ({
      appInstanceId,
      documentGeneration: generation,
      snapshotId: '00000000-0000-4000-8000-000000000001',
      url: 'http://127.0.0.1:1/',
      title: 't',
      elements: [],
      truncated: false,
      coverage: [],
    }),
    act: async (action, binding, signal) => {
      if (control.state === 'paused_by_user') throw new AppControlFailure('paused_by_user', 'user');
      if (binding.documentGeneration !== generation) throw new AppControlFailure('stale_document', 'moved');
      acts.push(action);
      if (actGate) await actGate;
      if (signal.aborted) throw new AppControlFailure('cancelled', 'cancelled');
      if (action.type === 'type') welcome = action.text;
      if (action.type === 'navigate') generation++;
      if (action.type === 'waitFor' && 'testid' in action.target && action.target.testid === 'missing')
        throw new AppControlFailure('wait_timeout', 'timeout');
      return { documentGeneration: generation, navigated: action.type === 'navigate', url: 'http://127.0.0.1:1/' };
    },
    query: async (target) =>
      'testid' in target && target.testid === 'welcome-value'
        ? { count: 1, visible: true, enabled: true, text: welcome }
        : { count: 0, visible: false, enabled: false, text: null },
    bridge: async (request) => {
      bridgeCalls.push(request);
      if (request.op === 'describe') return { ok: true, data: { version: 1, commands: ['health.refresh'], states: ['welcome'] } };
      if (request.op === 'state') return { ok: true, data: { welcome: { value: welcome, saving: false } } };
      if (request.op === 'invoke' && JSON.stringify(request.input) !== '{}')
        return {
          ok: false,
          error: { code: 'command_invalid_input', message: 'bad', issues: [{ path: 'extra', message: 'Unrecognized key' }] },
        };
      return { ok: true, data: { refreshed: true } };
    },
    screenshot: async () => Buffer.from('png-bytes'),
    consoleMark: () => 0,
    consoleErrorsSince: () => [],
    beginControl: (runId, label) => {
      if (control.state === 'paused_by_user') throw new AppControlFailure('paused_by_user', 'user');
      control = { state: 'active', runId, since: 'now', lastAction: label };
    },
    releaseRun: (runId) => released.push(runId),
  };
  const agent = vi.fn(async (_target, _id, operation: AppAgentOperation): Promise<AppAgentResult> => {
    agentOps.push(operation);
    if (operation.op === 'describe') {
      if (describeGate) await describeGate;
      return { mode: 'http', cleanupConfirmed: true, envelope: { ok: true, data: revision } };
    }
    if (operation.op === 'snapshot')
      return {
        mode: 'http',
        cleanupConfirmed: true,
        envelope: { ok: true, data: { tables: { records: { rowCount: 2, sha256: welcome } } } },
      };
    if (operation.op === 'query' && /delete/i.test(operation.sql))
      return { mode: 'http', cleanupConfirmed: true, envelope: { ok: false, error: { code: 'write_rejected', message: '只读' } } };
    const envelope = { ok: true as const, data: { op: operation.op } };
    return {
      mode: 'http',
      cleanupConfirmed: true,
      envelope,
      ...(operation.op === 'seed' || operation.op === 'reset'
        ? {
            operation: {
              operationId: operation.operationId,
              appInstanceId: 'app-1',
              operation: operation.op,
              state: 'succeeded' as const,
              envelope,
            },
          }
        : {}),
    };
  });
  const restart = vi.fn();
  const ports: AppControlPorts = {
    context: async () => {
      if (context.runId === 'ended') throw new AppControlFailure('no_active_run', '执行已结束');
      return structuredClone(context);
    },
    ui: () => ui,
    agent,
    logs: async () => ({ text: 'log', truncated: false, totalBytes: 3 }),
    leaseValid: () => lease,
    restart,
    store: {
      appendAudit: async (record) => {
        audit.push(record);
      },
      writeEvidence: async (runId, scenarioRunId, name, data) => {
        const key = `app-control/${runId}/scenarios/${scenarioRunId}/${name}`;
        if (evidence.has(key)) throw new Error('exists');
        evidence.set(key, data);
        return key;
      },
    },
  };
  const appControl = new AppControl(ports);
  return {
    control: appControl,
    ports,
    call: (tool: string, args: Record<string, unknown> = {}, signal?: AbortSignal) => appControl.call(scope, tool, args, signal),
    audit,
    evidence,
    bridgeCalls,
    acts,
    agentOps,
    agent,
    restart,
    released,
    setContext: (next: Partial<AppControlContext>) => (context = { ...context, ...next }),
    setRevision: (next: Partial<typeof revision>) => (revision = { ...revision, ...next }),
    setLease: (value: boolean) => (lease = value),
    setControl: (state: AgentControlState) => (control = state),
    gateDescribe: () => {
      let open!: () => void;
      describeGate = new Promise((resolve) => (open = resolve));
      return () => {
        describeGate = null;
        open();
      };
    },
    gateActs: () => {
      let open!: () => void;
      actGate = new Promise((resolve) => (open = resolve));
      return () => {
        actGate = null;
        open();
      };
    },
  };
}
const error = (result: AppControlResult) => (result.ok ? null : result.error.code);
const traceOf = (result: AppControlResult): AppScenarioTrace => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data.trace as AppScenarioTrace;
};
const act = { appInstanceId: 'app-1', documentGeneration: 4, action: { type: 'click', target: { testid: 'welcome-save' } } };
const invoke = (name: string, input: unknown) => ({ appInstanceId: 'app-1', documentGeneration: 4, name, input });

describe('AppControl authorization and risk levels', () => {
  it('rejects unknown tools, scripts and coordinates before any port is touched', async () => {
    const test = harness();
    expect(error(await test.call('app.eval', { code: '1' }))).toBe('unsupported');
    expect(error(await test.call('app.ui.act', { ...act, action: { type: 'click', x: 1, y: 2 } }))).toBe('invalid_request');
    expect(error(await test.call('app.ui.act', { ...act, script: 'document.body' }))).toBe('invalid_request');
    expect(error(await test.call('app.command.invoke', { ...invoke('x', {}), code: 'alert(1)' }))).toBe('invalid_request');
    expect(test.agent).not.toHaveBeenCalled();
    expect(test.acts).toEqual([]);
  });
  it('requires an active run; stopped apps, old instances and revoked leases are refused without effects', async () => {
    const test = harness();
    test.setContext({ runId: 'ended' });
    expect(error(await test.call('app.ui.act', act))).toBe('no_active_run');
    test.setContext({
      runId: 'run-1',
      app: { projectId: 'p', appInstanceId: 'app-1', state: 'stopped', url: null, cleanupConfirmed: true, error: null },
    });
    expect(error(await test.call('app.ui.act', act))).toBe('app_not_running');
    test.setContext({ app: { projectId: 'p', appInstanceId: 'app-2', state: 'running', url: 'x', cleanupConfirmed: false, error: null } });
    expect(error(await test.call('app.ui.act', act))).toBe('stale_instance');
    test.setContext({ app: { projectId: 'p', appInstanceId: 'app-1', state: 'running', url: 'x', cleanupConfirmed: false, error: null } });
    test.setLease(false);
    expect(error(await test.call('app.ui.act', act))).toBe('stale_lease');
    expect(error(await test.call('app.data.seed', { appInstanceId: 'app-1' }))).toBe('stale_lease');
    expect(test.acts).toEqual([]);
    expect(test.agentOps.filter((op) => op.op !== 'describe')).toEqual([]);
  });
  it('refuses stale documents, stale manifests and stale builds; restart remains the recovery path', async () => {
    const test = harness();
    expect(error(await test.call('app.ui.act', { ...act, documentGeneration: 3 }))).toBe('stale_document');
    test.setRevision({ currentRevision: OTHER });
    const stale = await test.call('app.ui.act', act);
    expect(error(stale)).toBe('manifest_stale');
    const described = await test.call('app.describe');
    expect(described.ok && described.data.stale).toEqual({ manifest: true, build: true });
    test.setRevision({ manifestRevision: OTHER, manifest: { ...manifest, sourceRevision: OTHER } });
    expect(error(await test.call('app.ui.act', act))).toBe('build_stale');
    expect(error(await test.call('app.command.invoke', invoke('health.refresh', {})))).toBe('build_stale');
    expect(test.acts).toEqual([]);
    const restarted = await test.call('app.restart', { appInstanceId: 'app-1' });
    expect(restarted.ok).toBe(true);
    expect(test.restart).toHaveBeenCalledWith('w', 'app-1');
    test.setRevision({ buildRevision: OTHER });
    expect((await test.call('app.ui.act', act)).ok).toBe(true);
  });
  it('data.reset needs the user authorization marker and only ever targets the current instance', async () => {
    const test = harness();
    const args = { appInstanceId: 'app-1', confirm: 'reset-instance-data' };
    expect(error(await test.call('app.data.reset', args))).toBe('authorization_required');
    expect(test.agentOps.some((op) => op.op === 'reset')).toBe(false);
    test.setContext({ allowsReset: true });
    const reset = await test.call('app.data.reset', args);
    expect(reset.ok).toBe(true);
    expect(test.agent).toHaveBeenLastCalledWith(
      { workspaceId: 'w', projectId: 'p' },
      'app-1',
      { op: 'reset', operationId: expect.any(String) },
      expect.any(AbortSignal),
    );
    expect(error(await test.call('app.data.query', { sql: 'DELETE FROM records' }))).toBe('write_rejected');
  });
  it('command.invoke rejects names outside the manifest before touching the page and surfaces schema issues', async () => {
    const test = harness();
    expect(error(await test.call('app.command.invoke', invoke('eval.anything', {})))).toBe('command_not_found');
    expect(test.bridgeCalls).toEqual([]);
    const invalid = await test.call('app.command.invoke', invoke('health.refresh', { extra: 1 }));
    expect(invalid.ok ? null : invalid.error).toMatchObject({ code: 'command_invalid_input', details: { issues: [{ path: 'extra' }] } });
    expect((await test.call('app.command.invoke', invoke('health.refresh', {}))).ok).toBe(true);
  });
  it('paused_by_user stops page writes until the user resumes', async () => {
    const test = harness();
    test.setControl({ state: 'paused_by_user', runId: 'run-1', since: 'now', lastAction: 'click' });
    expect(error(await test.call('app.ui.act', act))).toBe('paused_by_user');
    expect(error(await test.call('app.command.invoke', invoke('health.refresh', {})))).toBe('paused_by_user');
  });
  it.each(['app.data.seed', 'app.data.reset', 'app.restart'])('paused_by_user blocks %s without backend effects', async (tool) => {
    const test = harness({ allowsReset: true });
    test.setControl({ state: 'paused_by_user', runId: 'run-1', since: 'now', lastAction: 'click' });
    const result = await test.call(tool, {
      appInstanceId: 'app-1',
      ...(tool === 'app.data.reset' ? { confirm: 'reset-instance-data' } : {}),
    });
    expect(test.agentOps.filter((op) => op.op !== 'describe')).toEqual([]);
    expect(test.restart).not.toHaveBeenCalled();
    expect(error(result)).toBe('paused_by_user');
  });
  it('pre-cancelled restart never reaches the lifecycle port', async () => {
    const test = harness();
    const controller = new AbortController();
    controller.abort();
    const result = await test.call('app.restart', { appInstanceId: 'app-1' }, controller.signal);
    expect(test.restart).not.toHaveBeenCalled();
    expect(error(result)).toBe('cancelled');
  });
  it.each(['cancel', 'release', 'instance', 'run'])('queued restart rechecks %s before lifecycle effects', async (change) => {
    const test = harness();
    const open = test.gateActs();
    const first = test.call('app.ui.act', act);
    await vi.waitFor(() => expect(test.acts).toHaveLength(1));
    const controller = new AbortController();
    const queued = test.call('app.restart', { appInstanceId: 'app-1' }, controller.signal);
    await vi.waitFor(() => expect(test.agentOps).toHaveLength(1));
    // Let the queued request finish its initial context read before changing the facts.
    await Promise.resolve();
    if (change === 'cancel') controller.abort();
    if (change === 'release') test.control.releaseRun('run-1');
    if (change === 'instance')
      test.setContext({
        app: { projectId: 'p', appInstanceId: 'app-2', state: 'running', url: 'x', cleanupConfirmed: false, error: null },
      });
    if (change === 'run') test.setContext({ runId: 'ended' });
    open();
    await first;
    const result = await queued;
    expect(test.restart).not.toHaveBeenCalled();
    expect(error(result)).toBe(change === 'instance' ? 'stale_instance' : change === 'run' ? 'no_active_run' : 'cancelled');
  });
  it.each(['pause', 'cancel', 'instance', 'run'])('seed rechecks %s after awaiting revision before a backend write', async (change) => {
    const test = harness();
    const open = test.gateDescribe();
    const controller = new AbortController();
    const pending = test.call('app.data.seed', { appInstanceId: 'app-1' }, controller.signal);
    await vi.waitFor(() => expect(test.agentOps).toHaveLength(1));
    if (change === 'pause') test.setControl({ state: 'paused_by_user', runId: 'run-1', since: 'now', lastAction: 'click' });
    if (change === 'cancel') controller.abort();
    if (change === 'instance')
      test.setContext({
        app: { projectId: 'p', appInstanceId: 'app-2', state: 'running', url: 'x', cleanupConfirmed: false, error: null },
      });
    if (change === 'run') test.setContext({ runId: 'ended' });
    open();
    const result = await pending;
    expect(test.agentOps).toEqual([{ op: 'describe' }]);
    expect(error(result)).toBe(
      change === 'pause' ? 'paused_by_user' : change === 'instance' ? 'stale_instance' : change === 'run' ? 'no_active_run' : 'cancelled',
    );
  });
  it.each(
    ['app.data.seed', 'app.data.reset'].flatMap((tool) =>
      ['tracking', 'publication'].flatMap((boundary) =>
        ['pause', 'cancel', 'lease', 'instance', 'run'].map((change) => ({ tool, boundary, change })),
      ),
    ),
  )('$tool rechecks $change after $boundary before dispatch', async ({ tool, boundary, change }) => {
    const test = harness({ allowsReset: true });
    const controller = new AbortController();
    const changeAuthority = () => {
      if (change === 'pause') test.setControl({ state: 'paused_by_user', runId: 'run-1', since: 'now', lastAction: 'click' });
      if (change === 'cancel') controller.abort();
      if (change === 'lease') test.setLease(false);
      if (change === 'instance')
        test.setContext({
          app: { projectId: 'p', appInstanceId: 'app-2', state: 'running', url: 'x', cleanupConfirmed: false, error: null },
        });
      if (change === 'run') test.setContext({ runId: 'ended' });
    };
    let descriptions = 0;
    const original = test.ports.agent;
    test.ports.agent = async (...args) => {
      const result = await original(...args);
      if (args[2].op === 'describe' && ++descriptions === 2 && boundary === 'tracking') changeAuthority();
      return result;
    };
    let persisted: Parameters<NonNullable<typeof test.ports.store.savePending>>[0] = [];
    test.ports.store.savePending = async (operations) => {
      persisted = structuredClone(operations);
      if (boundary === 'publication' && operations.length) changeAuthority();
    };
    const result = await test.call(
      tool,
      { appInstanceId: 'app-1', ...(tool === 'app.data.reset' ? { confirm: 'reset-instance-data' } : {}) },
      controller.signal,
    );
    expect(test.agentOps.filter((operation) => operation.op === 'seed' || operation.op === 'reset')).toEqual([]);
    const errors: Record<string, string> = {
      pause: 'paused_by_user',
      cancel: 'cancelled',
      lease: 'stale_lease',
      instance: 'stale_instance',
      run: 'no_active_run',
    };
    expect(error(result)).toBe(errors[change]);
    expect(persisted).toEqual([]);
    expect(test.control.hasPending('w')).toBe(false);
  });
  it.each(['instance', 'browser', 'run'])('rejects a late describe result after %s changes', async (change) => {
    const test = harness();
    const open = test.gateDescribe();
    const pending = test.call('app.describe');
    await vi.waitFor(() => expect(test.agentOps).toHaveLength(1));
    if (change === 'instance')
      test.setContext({
        app: { projectId: 'p', appInstanceId: 'app-2', state: 'running', url: 'x', cleanupConfirmed: false, error: null },
      });
    if (change === 'browser') test.setContext({ browser: { resourceId: 'r', instanceId: 'new-browser', generation: 2 } });
    if (change === 'run') test.setContext({ runId: 'ended' });
    open();
    expect(error(await pending)).toBe(change === 'instance' ? 'stale_instance' : change === 'browser' ? 'stale_document' : 'no_active_run');
    expect(test.audit.at(-1)?.outcome).not.toBe('ok');
  });
  it('rejects a late UI action result after the app instance is replaced', async () => {
    const test = harness();
    const open = test.gateActs();
    const pending = test.call('app.ui.act', act);
    await vi.waitFor(() => expect(test.acts).toHaveLength(1));
    test.setContext({
      app: { projectId: 'p', appInstanceId: 'app-2', state: 'running', url: 'x', cleanupConfirmed: false, error: null },
    });
    open();
    expect(error(await pending)).toBe('stale_instance');
    expect(test.acts).toHaveLength(1);
  });
  it('audits every call with redacted text and SQL', async () => {
    const test = harness();
    await test.call('app.ui.act', { ...act, action: { type: 'type', target: { testid: 'welcome-input' }, text: 'secret words' } });
    await test.call('app.data.query', { sql: "SELECT 'hidden literal'" });
    expect(test.audit).toHaveLength(2);
    const serialized = JSON.stringify(test.audit);
    expect(serialized).not.toContain('secret words');
    expect(serialized).not.toContain('hidden literal');
    expect(test.audit[0]).toMatchObject({
      tool: 'app.ui.act',
      level: 'write',
      outcome: 'ok',
      documentGenerationBefore: 4,
      appInstanceId: 'app-1',
    });
    expect(summarizeArgs({ action: { text: 'abc' } }).summary['action.text']).toMatch(/^len:3 sha256:/);
  });
});

describe('AppControl scenarios', () => {
  const scenario = {
    name: 'fixed welcome',
    steps: [
      { type: 'act', action: { type: 'navigate', path: '/' } },
      { type: 'act', action: { type: 'type', target: { testid: 'welcome-input' }, text: '固定验收 2026' } },
      { type: 'act', action: { type: 'click', target: { testid: 'welcome-save' } } },
      { type: 'assert', assert: { kind: 'text', testid: 'welcome-value', equals: '固定验收 2026' } },
      { type: 'assert', assert: { kind: 'state', name: 'welcome', path: '/value', equals: '固定验收 2026' } },
      { type: 'assert', assert: { kind: 'console-no-error' } },
      { type: 'screenshot', label: 'saved' },
    ],
  };
  it('replays deterministically with evidence bound to revision and app instance', async () => {
    const test = harness();
    const traces: AppScenarioTrace[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await test.call('app.scenario.run', { appInstanceId: 'app-1', scenario });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      traces.push(traceOf(result));
    }
    expect(traces[0]!.outcome).toBe('passed');
    expect(comparableTrace(traces[0]!)).toEqual(comparableTrace(traces[1]!));
    expect(traces[0]!).toMatchObject({ appInstanceId: 'app-1', sourceRevision: REVISION, runId: 'run-1' });
    expect(traces[0]!.scenarioRunId).not.toBe(traces[1]!.scenarioRunId);
    expect(traces[0]!.stateDiff.map((entry) => entry.path)).toEqual(['/db/records/sha256', '/state/welcome/value']);
    expect([...test.evidence.keys()].filter((key) => key.endsWith('trace.json'))).toHaveLength(2);
    expect([...test.evidence.keys()].filter((key) => key.endsWith('06-saved.png'))).toHaveLength(2);
    for (const [file, png] of test.evidence) if (file.endsWith('.png')) expect(png).toEqual(Buffer.from('png-bytes'));
  });
  it('an empty screenshot is an evidence error, is not saved, and stops subsequent scenario steps', async () => {
    const test = harness();
    const screenshot = vi.spyOn(test.ports.ui('r'), 'screenshot').mockResolvedValue(Buffer.alloc(0));
    const result = await test.call('app.scenario.run', {
      appInstanceId: 'app-1',
      scenario: {
        name: 'after-style',
        steps: [
          { type: 'screenshot', label: 'after-style' },
          { type: 'assert', assert: { kind: 'console-no-error' } },
        ],
      },
    });
    const trace = traceOf(result);
    expect(trace.outcome).toBe('error');
    expect(trace.steps[0]).toMatchObject({ outcome: 'failed', error: { code: 'unavailable' }, screenshot: null });
    expect(trace.steps[1]).toMatchObject({ outcome: 'skipped', screenshot: null });
    expect(screenshot).toHaveBeenCalledOnce();
    expect([...test.evidence.keys()].some((file) => file.endsWith('.png'))).toBe(false);
    expect(result).toMatchObject({ ok: true, data: { outcome: 'error', evidence: { screenshots: [] } } });
    const traceFile = [...test.evidence.keys()].find((file) => file.endsWith('trace.json'))!;
    expect(JSON.parse(String(test.evidence.get(traceFile)))).toEqual(trace);
  });
  it('source changes during a scenario cannot relabel old actions as evidence for the new revision', async () => {
    const test = harness();
    const open = test.gateActs();
    const pending = test.call('app.scenario.run', { appInstanceId: 'app-1', scenario });
    await vi.waitFor(() => expect(test.acts).toHaveLength(1));
    test.setRevision({ currentRevision: OTHER });
    open();
    const result = await pending;
    const trace = traceOf(result);
    expect(trace.sourceRevision).toBe(REVISION);
    expect(trace.outcome).toBe('error');
    expect(trace.steps.every((step) => step.outcome === 'passed')).toBe(true);
    const revisionKey = [...test.evidence.keys()].find((key) => key.endsWith('revision-check.json'))!;
    expect(JSON.parse(String(test.evidence.get(revisionKey)))).toMatchObject({
      sourceRevision: REVISION,
      currentRevision: OTHER,
      error: { code: 'manifest_stale' },
    });
  });
  it('a failing step stops the scenario and marks the rest skipped', async () => {
    const test = harness();
    const result = await test.call('app.scenario.run', {
      appInstanceId: 'app-1',
      scenario: {
        name: 'missing',
        steps: [{ type: 'act', action: { type: 'waitFor', target: { testid: 'missing' }, timeoutMs: 10 } }, ...scenario.steps],
      },
    });
    const trace = traceOf(result);
    expect(trace.outcome).toBe('failed');
    expect(trace.steps[0]).toMatchObject({ outcome: 'failed', error: { code: 'wait_timeout' } });
    expect(trace.steps.slice(1).every((step) => step.outcome === 'skipped')).toBe(true);
  });
  it('cancellation stops new steps, waits for the in-flight action, keeps evidence and releases the run', async () => {
    const test = harness();
    const open = test.gateActs();
    const controller = new AbortController();
    const running = test.call('app.scenario.run', { appInstanceId: 'app-1', scenario }, controller.signal);
    await vi.waitFor(() => expect(test.acts).toHaveLength(1));
    controller.abort();
    open();
    const result = await running;
    expect(error(result)).toBe('cancelled');
    expect(test.acts).toHaveLength(1);
    const traceKey = [...test.evidence.keys()].find((key) => key.endsWith('trace.json'))!;
    const trace = JSON.parse(String(test.evidence.get(traceKey))) as AppScenarioTrace;
    expect(trace.outcome).toBe('cancelled');
    expect(trace.inFlight).toEqual({ kind: 'act', settled: true });
    expect(trace.steps.slice(1).every((step) => step.outcome === 'cancelled')).toBe(true);
    expect(trace.cleanupConfirmed).toBe(true);
    test.control.releaseRun('run-1');
    expect(test.released).toEqual(['run-1']);
  });
  it('releaseRun aborts in-flight calls of that run', async () => {
    const test = harness();
    const open = test.gateActs();
    const pending = test.call('app.ui.act', act);
    await vi.waitFor(() => expect(test.acts).toHaveLength(1));
    test.control.releaseRun('run-1');
    open();
    expect(error(await pending)).toBe('cancelled');
  });
});

describe('jsonDiff', () => {
  it('reports leaf paths that changed', () => {
    expect(jsonDiff({ a: { b: 1, c: 2 }, d: [1] }, { a: { b: 1, c: 3 }, d: [2], e: true })).toEqual([
      { path: '/a/c', before: 2, after: 3 },
      { path: '/d', before: [1], after: [2] },
      { path: '/e', before: null, after: true },
    ]);
  });
});

describe('persistent operation ownership', () => {
  it('persists before dispatch, survives run release and restart, and rejects writes until a matching terminal receipt', async () => {
    const test = harness({ allowsReset: true, executionBinding: { generation: 'original-generation', turnId: 'original-turn' } });
    let saved: Parameters<NonNullable<typeof test.ports.store.savePending>>[0] = [];
    test.ports.store.savePending = async (operations) => {
      saved = structuredClone(operations);
    };
    const original = test.agent.getMockImplementation()!;
    test.agent.mockImplementation(async (target, instance, operation) => {
      if (operation.op !== 'seed') return original(target, instance, operation);
      expect(saved).toMatchObject([
        {
          operationId: operation.operationId,
          appInstanceId: 'app-1',
          runId: 'run-1',
          generation: 'original-generation',
          turnId: 'original-turn',
        },
      ]);
      return { mode: 'http', cleanupConfirmed: false, envelope: { ok: false, error: { code: 'unavailable', message: 'unknown' } } };
    });
    expect((await test.call('app.data.seed', { appInstanceId: 'app-1' })).ok).toBe(false);
    test.control.releaseRun(scope.runId);
    expect(test.control.hasPending('w', scope.runId)).toBe(true);
    expect(error(await test.call('app.command.invoke', invoke('health.refresh', {})))).toBe('app_busy');
    const resumed = new AppControl({ ...test.ports, store: { ...test.ports.store, loadPending: async () => structuredClone(saved) } });
    await resumed.ready();
    expect(resumed.hasPending('w')).toBe(true);
    const pending = saved[0]!;
    const envelope = { ok: true as const, data: { seeded: true } };
    test.agent.mockImplementation(async () => ({
      mode: 'http',
      cleanupConfirmed: true,
      envelope,
      operation: { operationId: pending.operationId, appInstanceId: 'wrong-instance', operation: 'seed', state: 'succeeded', envelope },
    }));
    await resumed.reconcileRun('w', scope.runId);
    expect(resumed.hasPending('w')).toBe(true);
    test.agent.mockImplementation(async () => ({
      mode: 'http',
      cleanupConfirmed: true,
      envelope,
      operation: {
        operationId: pending.operationId,
        appInstanceId: pending.appInstanceId!,
        operation: 'seed',
        state: 'succeeded',
        envelope,
      },
    }));
    await resumed.reconcileRun('w', scope.runId);
    expect(resumed.hasPending('w')).toBe(false);
    expect(saved).toEqual([]);
  });
  it('retains stopped CLI cleanup ownership and only a confirmed owned stop clears it', async () => {
    const test = harness({
      app: { projectId: 'p', appInstanceId: null, state: 'stopped', url: null, cleanupConfirmed: true, error: null },
    });
    test.agent.mockResolvedValue({
      mode: 'cli',
      cleanupConfirmed: false,
      envelope: { ok: false, error: { code: 'unavailable', message: 'CLI done unconfirmed' } },
    });
    await test.call('app.describe');
    expect(test.control.hasPending('w', scope.runId)).toBe(true);
    await test.control.reconcileRun('w', scope.runId);
    expect(test.control.hasPending('w')).toBe(true);
    await test.control.confirmStopped('other', 'p', null);
    expect(test.control.hasPending('w')).toBe(true);
    await test.control.confirmStopped('w', 'p', null);
    expect(test.control.hasPending('w')).toBe(false);
  });
});

describe('pending publication failures', () => {
  it('keeps protection when withdrawal of an unstarted operation cannot be persisted', async () => {
    const test = harness();
    test.ports.store.savePending = async (operations) => {
      if (!operations.length) throw new Error('disk full');
      test.setControl({ state: 'paused_by_user', runId: 'run-1', since: 'now', lastAction: 'click' });
    };
    expect(error(await test.call('app.data.seed', { appInstanceId: 'app-1' }))).toBe('unavailable');
    expect(test.agentOps.filter((operation) => operation.op !== 'describe')).toEqual([]);
    expect(test.control.hasPending('w')).toBe(true);
    expect(test.control.canRetryCleanup('run-1')).toBe(true);
    expect(test.control.isReconciling('run-1')).toBe(false);
    expect(error(await test.call('app.restart', { appInstanceId: 'app-1' }))).toBe('app_busy');
    expect(test.restart).not.toHaveBeenCalled();
  });
  it('keeps protection if publishing terminal removal fails', async () => {
    const test = harness();
    let publications = 0;
    test.ports.store.savePending = async () => {
      if (++publications > 1) throw new Error('disk full');
    };
    await test.call('app.data.seed', { appInstanceId: 'app-1' });
    expect(test.control.hasPending('w')).toBe(true);
    expect(error(await test.call('app.restart', { appInstanceId: 'app-1' }))).toBe('app_busy');
    expect(test.restart).not.toHaveBeenCalled();
  });
  it('safe cancellation between persistence and adapter dispatch removes only a proven unstarted operation', async () => {
    const test = harness();
    const controller = new AbortController();
    test.ports.store.savePending = async (operations) => {
      if (operations.length) controller.abort();
    };
    test.agent.mockImplementation(async (_target, _instance, operation) =>
      operation.op === 'seed'
        ? {
            mode: 'http',
            cleanupConfirmed: true,
            operationDispatched: false,
            envelope: { ok: false, error: { code: 'cancelled', message: 'before dispatch' } },
          }
        : {
            mode: 'http',
            cleanupConfirmed: true,
            envelope: {
              ok: true,
              data: {
                operationTrackingVersion: 1,
                currentRevision: REVISION,
                manifestRevision: REVISION,
                buildRevision: REVISION,
                manifest,
              },
            },
          },
    );
    expect(error(await test.call('app.data.seed', { appInstanceId: 'app-1' }, controller.signal))).toBe('cancelled');
    expect(test.control.hasPending('w')).toBe(false);
  });
});

it('does not treat a cancelled HTTP reconciliation request as proof that an existing CLI exited', async () => {
  const test = harness({ app: { projectId: 'p', appInstanceId: null, state: 'stopped', url: null, cleanupConfirmed: true, error: null } });
  test.agent.mockResolvedValue({
    mode: 'cli',
    cleanupConfirmed: false,
    envelope: { ok: false, error: { code: 'unavailable', message: 'CLI cleanup unknown' } },
  });
  await test.call('app.describe');
  expect(test.control.hasPending('w')).toBe(true);
  test.agent.mockResolvedValue({
    mode: 'http',
    cleanupConfirmed: true,
    envelope: { ok: false, error: { code: 'cancelled', message: 'only reconciliation cancelled' } },
  });
  await test.control.reconcileRun('w', scope.runId);
  expect(test.control.hasPending('w')).toBe(true);
});

describe('Mota dedicated dispatcher', () => {
  const binding = {
    workspaceId: 'w',
    environmentId: 'sandbox' as const,
    projectId: 'p',
    appInstanceId: 'app-1',
    runId: 'run-1',
    sessionId: 's',
    resourceId: 'r',
    browserInstanceId: 'i',
    browserGeneration: 1,
    webContentsId: 7,
    documentGeneration: 4,
  };
  const state = {
    appInstanceId: 'app-1',
    documentGeneration: 4,
    played: false,
    floorId: null,
    hero: null,
    moving: false,
    locked: false,
    event: { id: null, type: null },
    dialogue: null,
    map: null,
    canvas: null,
  };
  it('admits only dedicated Mota tools and refuses them on a standard task', async () => {
    const h = harness({ motaTask: binding });
    h.ports.ui('r').motaState = vi.fn(async () => state);
    expect(await h.call('app.mota.state')).toMatchObject({ ok: true, data: state });
    for (const tool of ['app.describe', 'app.ui.snapshot', 'app.command.list', 'app.status'])
      expect(await h.call(tool)).toMatchObject({ ok: false, error: { code: 'unsupported' } });
    expect(h.agent).not.toHaveBeenCalled();
    expect(h.bridgeCalls).toEqual([]);
    expect(await harness().call('app.mota.state')).toMatchObject({ ok: false, error: { code: 'authorization_required' } });
  });
  it('requires independent map permission and creates operation identity in Main', async () => {
    const h = harness({ motaTask: binding });
    const mapSet = { appInstanceId: 'app-1', expectedSha256: REVISION, x: 6, y: 10 };
    h.ports.motaControl = vi.fn<NonNullable<AppControlPorts['motaControl']>>(async (request) => ({
      type: 'mota-control-result',
      requestId: request.requestId,
      binding: request.binding,
      method: 'map.set',
      ok: true,
      data: {
        operationId: '00000000-0000-4000-8000-000000000001',
        floorId: 'MT1',
        beforeSha256: REVISION,
        afterSha256: OTHER,
        change: { x: 6, y: 10, before: 0, after: 53 },
      },
    }));
    expect(await h.call('app.mota.map.set', mapSet)).toMatchObject({ ok: false, error: { code: 'authorization_required' } });
    expect(h.ports.motaControl).not.toHaveBeenCalled();
    h.setContext({ allowsMotaMapWrite: true });
    expect(await h.call('app.mota.map.set', { ...mapSet, value: 999 })).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await h.call('app.mota.map.set', mapSet)).toMatchObject({ ok: true });
    expect(h.ports.motaControl).toHaveBeenCalledWith(
      expect.objectContaining({
        binding,
        method: 'map.set',
        input: { operationId: expect.any(String), expectedSha256: REVISION, x: 6, y: 10 },
      }),
      expect.any(AbortSignal),
    );
  });
  it('only newGame can advance the authorized document, with the exact old and new generation', async () => {
    const h = harness({ motaTask: binding });
    h.ports.ui('r').motaAct = vi.fn(async () => ({ ...state, documentGeneration: 5 }));
    h.ports.motaDocumentChanged = vi.fn(async () => undefined);
    expect(await h.call('app.mota.act', { appInstanceId: 'app-1', documentGeneration: 4, action: { type: 'continue' } })).toMatchObject({
      ok: false,
      error: { code: 'stale_document' },
    });
    expect(h.ports.motaDocumentChanged).not.toHaveBeenCalled();
    expect(await h.call('app.mota.act', { appInstanceId: 'app-1', documentGeneration: 4, action: { type: 'newGame' } })).toMatchObject({
      ok: true,
    });
    expect(h.ports.motaDocumentChanged).toHaveBeenCalledWith(binding, 4, 5);
  });
  it('waits for an aborted native action to finish input cleanup before run settlement', async () => {
    const h = harness({ motaTask: binding });
    let inputReleased = false;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    h.ports.ui('r').motaAct = vi.fn(async (_action, _binding, signal) => {
      await gate;
      inputReleased = true;
      signal.throwIfAborted();
      return state;
    });
    const call = h.call('app.mota.act', { appInstanceId: 'app-1', documentGeneration: 4, action: { type: 'key', key: 'ArrowUp' } });
    await vi.waitFor(() => expect(h.ports.ui('r').motaAct).toHaveBeenCalledOnce());
    let settled = false;
    const release = h.control.settleRun(binding.runId).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(inputReleased).toBe(false);
    finish();
    await release;
    expect(inputReleased).toBe(true);
    expect(await call).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  });
});
