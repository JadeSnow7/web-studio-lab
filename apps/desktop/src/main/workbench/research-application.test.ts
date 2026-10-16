import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  WorkbenchCommandSchema,
  type ChatConversation,
  type ManagedApp,
  type PageResourceSnapshot,
  type PreviewState,
  type ResearchCall,
  type ResearchGrant,
  type ResourceCatalogState,
  type WorkbenchSnapshot,
} from '@wsl/protocol';
import { WorkbenchApplication } from './application';
import { assertCatalogBindings, type WorkbenchRepository } from './repository';
import type { WorkbenchRuntime } from './ports';
import { createResourceCatalog } from './resource-catalog';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const unused = async (): Promise<never> => {
  throw new Error('unexpected runtime call');
};
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const page: PreviewState = {
  page: { webContentsId: 42, documentGeneration: 1, url: 'http://127.0.0.1:49152', title: 'App', partition: 'fixture' },
  loading: false,
  picking: false,
  canGoBack: false,
  canGoForward: false,
  consoleIssueCount: 0,
  cdp: { state: 'attached' },
  pickError: null,
  loadError: null,
  blockedNavigation: null,
};
async function fixture(authorized = true) {
  let saved: WorkbenchSnapshot | null = null;
  let catalog = createResourceCatalog('account');
  let managed: ManagedApp;
  let grant: ResearchGrant | undefined;
  let turn: ChatConversation;
  let sequence = 0;
  const states = new Map<string, PreviewState>();
  const document = (url: string, text = 'Actual public body'): PageResourceSnapshot => ({
    page: { ...page.page, webContentsId: 43, url, title: 'Public article' },
    requestedUrl: url,
    url,
    title: 'Public article',
    text,
    capturedAt: new Date().toISOString(),
    sourceSha256: digest('<html>' + text + '</html>'),
    contentSha256: digest(text),
    extractionVersion: 'html-text-v1',
    truncated: false,
  });
  const open = vi.fn<NonNullable<WorkbenchRuntime['openResearchDocument']>>(async (id, url) => {
    const snapshot = document(url);
    states.set(id, { ...page, page: snapshot.page as PreviewState['page'] });
    return snapshot;
  });
  const save = vi.fn(async (snapshot: WorkbenchSnapshot, nextCatalog: ResourceCatalogState) => {
    assertCatalogBindings(snapshot, nextCatalog);
    saved = structuredClone(snapshot);
    catalog = structuredClone(nextCatalog);
  });
  const repository: WorkbenchRepository = {
    migrationPending: false,
    load: async () => saved,
    loadCatalog: async () => catalog,
    save,
    appendObservation: unused,
  };
  const runtime: WorkbenchRuntime = {
    appCreate: async (target) =>
      (managed = {
        ...target,
        environmentId: 'sandbox',
        appInstanceId: null,
        state: 'created',
        url: null,
        guestCwd: '/guest/project',
        error: null,
        cleanupConfirmed: true,
      }),
    appStart: async () =>
      (managed = { ...managed, state: 'running', appInstanceId: randomUUID(), url: page.page.url, cleanupConfirmed: false }),
    appGet: async () => ({ ...managed, state: 'stopped', url: null, cleanupConfirmed: true }),
    environmentsList: async () => [],
    registerSession: async () => undefined,
    registerResource: async () => undefined,
    releaseResource: async () => undefined,
    observe: unused,
    captureResource: unused,
    validateBrowserUrl: () => undefined,
    ensureBrowser: (_workspace, resource) => {
      states.set(resource.resourceId, structuredClone(page));
    },
    browserState: (id) => states.get(id) ?? page,
    browserLayout: () => undefined,
    browserAction: () => undefined,
    hideBrowsers: () => undefined,
    openResearchDocument: open,
    terminalOpen: unused,
    terminalWrite: unused,
    terminalResize: unused,
    terminalStop: unused,
    send: async (sessionId, _text, _scope, _references, _edu, _mota, researchGrant) => {
      grant = researchGrant;
      return (turn = {
        conversationId: sessionId,
        generation: 'generation',
        turnId: randomUUID(),
        seq: ++sequence,
        threadId: null,
        state: 'running',
        messages: [],
        toolExecutions: [],
        warnings: [],
        cleanupPending: true,
        error: null,
      });
    },
    cancel: async () => ({ ...turn, seq: ++sequence, state: 'cancelled', cleanupPending: false }),
  };
  const events = vi.fn();
  const app = new WorkbenchApplication(repository, runtime, events);
  await app.getSnapshot();
  const command = (value: Record<string, unknown>) =>
    app.command(WorkbenchCommandSchema.parse({ commandId: randomUUID(), workspaceId: 'taskflow-demo', ...value }));
  expect((await command({ type: 'createApp' })).ok).toBe(true);
  expect((await command({ type: 'startApp' })).ok).toBe(true);
  const confirmCurrentTask = async (currentApp = app) => {
    const currentCommand = (value: Record<string, unknown>) =>
      currentApp.command(WorkbenchCommandSchema.parse({ commandId: randomUUID(), workspaceId: 'taskflow-demo', ...value }));
    const workspace = (await currentApp.getSnapshot()).workspaces[0]!;
    const sessionId = workspace.sessions[0]!.sessionId;
    const browser = workspace.resources.find((resource) => resource.appProjectId)!;
    const requestId = randomUUID();
    expect((await currentCommand({ type: 'captureContext', sessionId, resourceId: browser.resourceId, requestId })).ok).toBe(true);
    const current = (await currentApp.getSnapshot()).workspaces[0]!.resources.find((r) => r.resourceId === browser.resourceId)!;
    currentApp.onCapture(
      browser.resourceId,
      {
        captureId: randomUUID(),
        capturedAt: 'fixture',
        page: page.page,
        element: {
          tagName: 'h1',
          id: null,
          classes: [],
          role: null,
          ariaLabel: null,
          testId: null,
          text: 'title',
          selector: 'h1',
          rect: null,
        },
        screenshot: { viewport: 'data:image/png;base64,AA==', element: null },
        consoleIssues: [],
      },
      current.instanceId,
      current.generation,
      requestId,
    );
    await currentApp.getSnapshot();
    expect(
      (
        await currentCommand({
          type: 'confirmTask',
          sessionId,
          goal: 'Research publicly and save sources',
          targetRef: { kind: 'web', resourceId: browser.resourceId },
        })
      ).ok,
    ).toBe(true);
    return (await currentApp.getSnapshot()).workspaces[0]!.sessions[0]!.taskVersions.at(-1)!;
  };
  const version = await confirmCurrentTask();
  const sessionId = version.sessionId;
  expect((await command({ type: 'startRun', sessionId, taskVersionId: version.taskVersionId, webResearch: authorized })).ok).toBe(true);
  const run = () => saved!.workspaces[0]!.runs.at(-1)!;
  const call = (tool: ResearchCall['tool'], args: Record<string, unknown>): ResearchCall =>
    ({
      callId: randomUUID(),
      context: {
        grant: grant ?? {
          grantId: randomUUID(),
          accountId: 'account',
          workspaceId: 'taskflow-demo',
          sessionId,
          taskVersionId: run().taskVersionId,
          runId: run().runId,
          mode: 'live',
          purpose: 'public-web-research',
          grantedAt: new Date().toISOString(),
        },
        generation: turn.generation,
        turnId: turn.turnId,
      },
      tool,
      args,
    }) as ResearchCall;
  const invoke = (input: ResearchCall) => app.researchForTurn(input, new AbortController().signal);
  return {
    app,
    runtime,
    repository,
    save,
    open,
    command,
    confirmCurrentTask,
    run,
    call,
    invoke,
    document,
    states,
    events,
    snapshot: () => saved!,
    catalog: () => catalog,
    finish: () => app.onConversation({ ...turn, state: 'idle', cleanupPending: false, seq: ++sequence }),
  };
}

describe('current run public research', () => {
  it('seals actual reader bytes, persists explicit inclusion before body reply, and keeps original references and target', async () => {
    const f = await fixture();
    const references = structuredClone(f.run().referenceSnapshot);
    const target = structuredClone(f.run().targetRef);
    const opened = await f.invoke(f.call('research.open', { url: 'https://www.wikipedia.org/article' }));
    expect(opened.result).toMatchObject({ ok: true, tool: 'research.open' });
    if (!opened.result.ok || opened.result.tool !== 'research.open') throw new Error('no capture');
    expect(opened.result.capture).not.toHaveProperty('text');
    const capture = opened.result.capture;
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.run().research!.captures[0]!.text).toBe('Actual public body');
    const include = f.call('research.include', { captureId: capture.captureId, contentSha256: capture.contentSha256 });
    const included = await f.invoke(include);
    expect(included.result).toMatchObject({ ok: true, source: { text: 'Actual public body' } });
    expect(f.run().research!.inclusions).toHaveLength(1);
    expect((await f.invoke(include)).result).toEqual(included.result);
    expect(f.run().research!.inclusions).toHaveLength(1);
    expect(f.run().referenceSnapshot).toEqual(references);
    expect(f.run().targetRef).toEqual(target);
    const publicRun = (await f.app.getSnapshot()).workspaces[0]!.runs.at(-1)!;
    expect(publicRun.research).toBeUndefined();
    expect(JSON.stringify(publicRun.researchSummary)).not.toContain('Actual public body');
    expect(JSON.stringify(f.events.mock.calls)).not.toContain('Actual public body');
    const corrupt = structuredClone(f.snapshot());
    corrupt.workspaces[0]!.runs.at(-1)!.research!.captures[0]!.text = 'altered';
    expect(() => assertCatalogBindings(corrupt, f.catalog())).toThrow('正文');
  });
  it('rejects missing grant, foreign turn, wrong capture hash and restored historical permission', async () => {
    const denied = await fixture(false);
    const deniedSnapshot = structuredClone(denied.snapshot());
    const deniedSaveCount = denied.save.mock.calls.length;
    for (const input of [
      denied.call('research.open', { url: 'https://www.wikipedia.org/' }),
      denied.call('research.include', { captureId: randomUUID(), contentSha256: 'a'.repeat(64) }),
    ]) {
      const reply = await denied.invoke(input);
      expect(reply.result).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
      expect(JSON.stringify(reply)).not.toContain('Actual public body');
    }
    expect(denied.open).not.toHaveBeenCalled();
    expect(denied.save).toHaveBeenCalledTimes(deniedSaveCount);
    expect(denied.snapshot()).toEqual(deniedSnapshot);
    const f = await fixture();
    const call = f.call('research.open', { url: 'https://www.wikipedia.org/' });
    call.context.turnId = 'foreign';
    expect((await f.invoke(call)).result).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(f.open).not.toHaveBeenCalled();
    const opened = await f.invoke(f.call('research.open', { url: 'https://www.wikipedia.org/' }));
    if (!opened.result.ok || opened.result.tool !== 'research.open') throw new Error('no capture');
    expect(
      (await f.invoke(f.call('research.include', { captureId: opened.result.capture.captureId, contentSha256: 'a'.repeat(64) }))).result,
    ).toMatchObject({ ok: false });
    const restored = new WorkbenchApplication(f.repository, f.runtime, vi.fn());
    await restored.getSnapshot();
    expect(
      (await restored.researchForTurn(f.call('research.open', { url: 'https://www.wikipedia.org/' }), new AbortController().signal)).result,
    ).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
  });
  it('rolls back failed include persistence and never returns its body', async () => {
    const f = await fixture();
    const opened = await f.invoke(f.call('research.open', { url: 'https://www.wikipedia.org/' }));
    if (!opened.result.ok || opened.result.tool !== 'research.open') throw new Error('no capture');
    f.save.mockRejectedValueOnce(new Error('disk unavailable'));
    const reply = await f.invoke(
      f.call('research.include', { captureId: opened.result.capture.captureId, contentSha256: opened.result.capture.contentSha256 }),
    );
    expect(reply.result).toMatchObject({ ok: false, error: { code: 'storage_failed' } });
    expect(JSON.stringify(reply)).not.toContain('Actual public body');
    expect((await f.app.getSnapshot()).workspaces[0]!.runs.at(-1)!.researchSummary!.inclusions).toEqual([]);
  });
  it.each(['completed', 'cancelled', 'restored'] as const)(
    'rejects old open/include after %s and starts a different run without a grant',
    async (ending) => {
      const f = await fixture();
      const oldOpen = f.call('research.open', { url: 'https://www.wikipedia.org/' });
      const opened = await f.invoke(oldOpen);
      if (!opened.result.ok || opened.result.tool !== 'research.open') throw new Error('no capture');
      const oldInclude = f.call('research.include', {
        captureId: opened.result.capture.captureId,
        contentSha256: opened.result.capture.contentSha256,
      });
      expect((await f.invoke(oldInclude)).result).toMatchObject({ ok: true, source: { text: 'Actual public body' } });
      const previous = structuredClone(f.run());
      let currentApp = f.app;
      if (ending === 'restored') {
        currentApp = new WorkbenchApplication(f.repository, f.runtime, vi.fn());
        await currentApp.getSnapshot();
      } else if (ending === 'cancelled') {
        expect((await f.command({ type: 'cancelRun', runId: previous.runId })).ok).toBe(true);
      } else {
        f.finish();
      }
      await vi.waitFor(async () => {
        const current = (await currentApp.getSnapshot()).workspaces[0]!.runs.at(-1)!;
        expect(current.state).toBe(ending === 'restored' ? 'interrupted' : ending);
        expect(current.cleanupPending).toBe(false);
      });
      const invoke = (input: ResearchCall) => currentApp.researchForTurn(input, new AbortController().signal);
      const assertOldGrantDenied = async () => {
        const before = structuredClone(f.snapshot());
        const saveCount = f.save.mock.calls.length;
        const readerCount = f.open.mock.calls.length;
        for (const input of [oldOpen, oldInclude]) {
          const reply = await invoke(input);
          expect(reply.result).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
          expect(JSON.stringify(reply)).not.toContain('Actual public body');
        }
        expect(f.save).toHaveBeenCalledTimes(saveCount);
        expect(f.open).toHaveBeenCalledTimes(readerCount);
        expect(f.snapshot()).toEqual(before);
        const historical = f.snapshot().workspaces[0]!.runs.find((run) => run.runId === previous.runId)!;
        expect(historical.research!.captures).toEqual(previous.research!.captures);
        expect(historical.research!.inclusions).toEqual(previous.research!.inclusions);
      };
      await assertOldGrantDenied();
      const command = (value: Record<string, unknown>) =>
        currentApp.command(WorkbenchCommandSchema.parse({ commandId: randomUUID(), workspaceId: 'taskflow-demo', ...value }));
      let taskVersionId = previous.taskVersionId;
      if (ending === 'restored') {
        expect((await command({ type: 'startApp' })).ok).toBe(true);
        taskVersionId = (await f.confirmCurrentTask(currentApp)).taskVersionId;
      }
      const send = vi.spyOn(f.runtime, 'send');
      expect((await command({ type: 'startRun', sessionId: previous.sessionId, taskVersionId })).ok).toBe(true);
      await vi.waitFor(() => expect(f.run().state).toBe('running'));
      expect(f.run().runId).not.toBe(previous.runId);
      expect(f.run().research).toBeUndefined();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![6]).toBeUndefined();
      await assertOldGrantDenied();
      for (const input of [
        f.call('research.open', { url: 'https://www.wikipedia.org/' }),
        f.call('research.include', { captureId: opened.result.capture.captureId, contentSha256: opened.result.capture.contentSha256 }),
      ]) {
        expect((await invoke(input)).result).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
      }
    },
  );
  it('revokes immediately and waits for the actual read to settle before completing cancellation', async () => {
    const f = await fixture();
    const started = deferred<void>(),
      stopped = deferred<PageResourceSnapshot>();
    let signal!: AbortSignal;
    f.open.mockImplementation((_id, _url, current) => {
      signal = current;
      started.resolve();
      return stopped.promise;
    });
    const read = f.invoke(f.call('research.open', { url: 'https://www.wikipedia.org/' }));
    await started.promise;
    await f.command({ type: 'cancelRun', runId: f.run().runId });
    expect(signal.aborted).toBe(true);
    await vi.waitFor(async () => expect((await f.app.getSnapshot()).workspaces[0]!.runs.at(-1)!.state).toBe('cancelling'));
    let settled = false;
    void read.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    stopped.resolve(f.document('https://www.wikipedia.org/'));
    expect((await read).result).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    await vi.waitFor(async () => expect((await f.app.getSnapshot()).workspaces[0]!.runs.at(-1)!.state).toBe('cancelled'));
    expect(f.run().research!.captures).toEqual([]);
  });
  it('keeps a committed inclusion historical but withholds its body if cancelled during save', async () => {
    const f = await fixture();
    const opened = await f.invoke(f.call('research.open', { url: 'https://www.wikipedia.org/' }));
    if (!opened.result.ok || opened.result.tool !== 'research.open') throw new Error('no capture');
    const started = deferred<void>(),
      saved = deferred<void>();
    const original = f.save.getMockImplementation()!;
    f.save.mockImplementationOnce(async (...args) => {
      started.resolve();
      await saved.promise;
      await original(...args);
    });
    const include = f.invoke(
      f.call('research.include', { captureId: opened.result.capture.captureId, contentSha256: opened.result.capture.contentSha256 }),
    );
    await started.promise;
    const cancellation = f.command({ type: 'cancelRun', runId: f.run().runId });
    saved.resolve();
    expect((await include).result).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    await cancellation;
    expect(f.run().research!.inclusions).toHaveLength(1);
  });
  it('rejects an in-flight second navigation and releases its reservation after a failed read', async () => {
    const f = await fixture();
    const started = deferred<void>(),
      failed = deferred<PageResourceSnapshot>();
    f.open.mockImplementationOnce(() => {
      started.resolve();
      return failed.promise;
    });
    const first = f.invoke(f.call('research.open', { url: 'https://www.wikipedia.org/first' }));
    await started.promise;
    expect((await f.invoke(f.call('research.open', { url: 'https://www.wikipedia.org/second' }))).result).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
    failed.resolve({ ...f.document('https://www.wikipedia.org/first'), contentSha256: 'a'.repeat(64) });
    expect((await first).result.ok).toBe(false);
    expect((await f.invoke(f.call('research.open', { url: 'https://www.wikipedia.org/next' }))).result.ok).toBe(true);
    expect(f.run().research!.captures).toHaveLength(1);
  });
  it('rejects a changed reader identity without sealing a different page', async () => {
    const f = await fixture();
    f.open.mockImplementationOnce(async (id, url) => {
      const snapshot = f.document(url);
      f.states.set(id, { ...page, page: { ...page.page, url: 'https://www.wikipedia.org/foreign' } });
      return snapshot;
    });
    expect((await f.invoke(f.call('research.open', { url: 'https://www.wikipedia.org/' }))).result).toMatchObject({
      ok: false,
      error: { code: 'stale' },
    });
    expect(f.run().research!.captures).toEqual([]);
  });
  it('refuses the seventeenth capture before loading and preserves sealed bodies after reader navigation', async () => {
    const f = await fixture();
    for (let index = 0; index < 16; index++) {
      expect((await f.invoke(f.call('research.open', { url: `https://www.wikipedia.org/${index}` }))).result.ok).toBe(true);
    }
    expect((await f.invoke(f.call('research.open', { url: 'https://www.wikipedia.org/overflow' }))).result).toMatchObject({
      ok: false,
      error: { code: 'budget_exceeded' },
    });
    expect(f.open).toHaveBeenCalledTimes(16);
    const first = f.run().research!.captures[0]!;
    expect(
      (await f.invoke(f.call('research.include', { captureId: first.captureId, contentSha256: first.contentSha256 }))).result,
    ).toMatchObject({ ok: true, source: { url: 'https://www.wikipedia.org/0' } });
  });
  it('waits for an aborted read during natural completion and shutdown', async () => {
    const f = await fixture(),
      started = deferred<void>(),
      done = deferred<PageResourceSnapshot>();
    let signal!: AbortSignal;
    f.open.mockImplementation((_id, _url, value) => {
      signal = value;
      started.resolve();
      return done.promise;
    });
    const reading = f.invoke(f.call('research.open', { url: 'https://www.wikipedia.org/' }));
    await started.promise;
    f.finish();
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    expect((await f.app.getSnapshot()).workspaces[0]!.runs.at(-1)!.state).toBe('cancelling');
    let stopped = false;
    const shutdown = f.app.shutdown().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    done.resolve(f.document('https://www.wikipedia.org/'));
    expect((await reading).result.ok).toBe(false);
    await shutdown;
    expect(stopped).toBe(true);
    expect(f.run().research!.captures).toEqual([]);
  });
  it('keeps permission revoked and cancels the executor even if cancellation persistence fails', async () => {
    const f = await fixture(),
      started = deferred<void>(),
      done = deferred<PageResourceSnapshot>();
    let signal!: AbortSignal;
    f.open.mockImplementation((_id, _url, value) => {
      signal = value;
      started.resolve();
      return done.promise;
    });
    const reading = f.invoke(f.call('research.open', { url: 'https://www.wikipedia.org/' }));
    await started.promise;
    const cancel = vi.spyOn(f.runtime, 'cancel');
    f.save.mockRejectedValueOnce(new Error('cancel save failed'));
    expect((await f.command({ type: 'cancelRun', runId: f.run().runId })).ok).toBe(false);
    expect(signal.aborted).toBe(true);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    done.resolve(f.document('https://www.wikipedia.org/'));
    expect((await reading).result).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect((await f.invoke(f.call('research.open', { url: 'https://www.wikipedia.org/new' }))).result.ok).toBe(false);
  });
});
