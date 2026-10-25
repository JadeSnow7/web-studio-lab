import { codexHarnessRuntime } from './harness-test-fixture';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogAction, PageResourceSnapshot, PreviewState } from '@wsl/protocol';
import { WorkbenchApplication } from './application';
import { FileWorkbenchRepository } from './repository';
import type { WorkbenchRuntime } from './ports';
import { CodexChat } from '../../../../service/src/codex-chat';
import type { GuestStart, SbxConnection } from '../../../../service/src/sbx';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const snapshot = (text = 'v1'): Extract<PageResourceSnapshot, { extractionVersion: 'html-text-v1' }> => ({
  page: { webContentsId: 42, documentGeneration: 1, url: 'https://example.com/', title: 'fixture', partition: 'fixture' },
  requestedUrl: 'https://example.com/',
  url: 'https://example.com/',
  title: 'fixture',
  text,
  capturedAt: '2026-10-10T00:00:00.000Z',
  sourceSha256: sha(text),
  contentSha256: sha(text),
  extractionVersion: 'html-text-v1',
  truncated: false,
});
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-account-seam-'));
  const file = path.join(root, 'workbench.json');
  const page = { ...snapshot().page };
  const runtime = {
    ...codexHarnessRuntime,
    environmentsList: vi.fn(async () => []),
    captureResource: vi.fn(async () => snapshot()),
    ensureBrowser: vi.fn(),
    browserState: () => ({ page }) as PreviewState,
    validateBrowserUrl: vi.fn(),
    hideBrowsers: vi.fn(),
    registerSession: vi.fn(),
    send: vi.fn(),
    cancel: vi.fn(),
  } as unknown as WorkbenchRuntime;
  const repository = new FileWorkbenchRepository(file);
  const app = new WorkbenchApplication(repository, runtime, vi.fn());
  await app.getSnapshot();
  await app.command({
    type: 'createTab',
    commandId: 'web',
    workspaceId: 'taskflow-demo',
    kind: 'web',
    title: 'fixture',
    url: snapshot().url,
  });
  const state = await app.getSnapshot();
  const web = state.workspaces[0]?.resources.find((resource) => resource.url === snapshot().url);
  if (!web?.catalogResourceId) throw new Error('fixture missing account binding');
  const catalog = async (
    action: CatalogAction extends infer A ? (A extends CatalogAction ? Omit<A, 'commandId' | 'expectedCatalogRevision'> : never) : never,
  ) =>
    app.catalogCommand({
      ...action,
      commandId: crypto.randomUUID(),
      expectedCatalogRevision: (await app.getSnapshot()).catalog?.revision ?? 0,
    } as CatalogAction);
  return { root, file, repository, app, runtime, web: { ...web, catalogResourceId: web.catalogResourceId }, page, catalog };
}
describe('Main account catalogue ownership seam R01-R10', () => {
  it('keeps favorites independent of workspace layout and supports more than 16 links', async () => {
    const f = await setup();
    for (let i = 0; i < 17; i++)
      expect((await f.catalog({ type: 'bookmarkLink', title: 'link ' + i, url: 'http://example.com/' + i } as CatalogAction)).ok).toBe(
        true,
      );
    const before = await f.app.getSnapshot();
    await f.app.command({ type: 'createWorkspace', commandId: 'B', workspaceId: 'B', name: 'B' });
    const after = await f.app.getSnapshot();
    expect(after.catalog?.library).toHaveLength(17);
    expect(after.catalog).toEqual(before.catalog);
    expect(f.runtime.captureResource).not.toHaveBeenCalled();
    expect(f.runtime.send).not.toHaveBeenCalled();
  });
  it('deduplicates a pending capture and keeps body out of snapshot events', async () => {
    const f = await setup();
    let release: (value: PageResourceSnapshot) => void = () => {
      throw new Error('capture not started');
    };
    vi.mocked(f.runtime.captureResource).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const action: CatalogAction = {
      type: 'captureResourceRevision',
      commandId: 'capture',
      expectedCatalogRevision: (await f.app.getSnapshot()).catalog?.revision ?? 0,
      workspaceId: 'taskflow-demo',
      runtimeResourceId: f.web.resourceId,
    };
    const first = f.app.catalogCommand(action),
      retry = f.app.catalogCommand(action);
    await vi.waitFor(() => expect(f.runtime.captureResource).toHaveBeenCalledOnce());
    release(snapshot('UNIQUE_BODY_SENTINEL'));
    expect((await first).ok).toBe(true);
    expect((await retry).ok).toBe(true);
    expect(f.runtime.captureResource).toHaveBeenCalledOnce();
    expect(JSON.stringify(await f.app.getSnapshot())).not.toContain('UNIQUE_BODY_SENTINEL');
    expect((await f.app.catalogRevision(f.web.catalogResourceId, 1)).text).toBe('UNIQUE_BODY_SENTINEL');
    expect((await f.app.catalogCommand(action)).ok).toBe(true);
    expect(f.runtime.captureResource).toHaveBeenCalledOnce();
  });
  it('rejects a late capture after native navigation without overwriting the previous version', async () => {
    const f = await setup();
    expect(
      (
        await f.catalog({
          type: 'captureResourceRevision',
          workspaceId: 'taskflow-demo',
          runtimeResourceId: f.web.resourceId,
        } as CatalogAction)
      ).ok,
    ).toBe(true);
    let release: (value: PageResourceSnapshot) => void = () => {
      throw new Error('capture not started');
    };
    vi.mocked(f.runtime.captureResource).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.catalog({
      type: 'captureResourceRevision',
      workspaceId: 'taskflow-demo',
      runtimeResourceId: f.web.resourceId,
    } as CatalogAction);
    await vi.waitFor(() => expect(f.runtime.captureResource).toHaveBeenCalledTimes(2));
    f.page.documentGeneration++;
    release(snapshot('late'));
    expect((await pending).ok).toBe(false);
    expect((await f.app.catalogRevision(f.web.catalogResourceId, 1)).text).toBe('v1');
    await expect(f.app.catalogRevision(f.web.catalogResourceId, 2)).rejects.toThrow();
  });
  it('rolls back failed atomic saves, then explicit retry can commit', async () => {
    const f = await setup();
    const bytes = await readFile(f.file, 'utf8'),
      before = await f.app.getSnapshot();
    const save = vi.spyOn(f.repository, 'save').mockRejectedValueOnce(new Error('disk write failed'));
    expect((await f.catalog({ type: 'bookmarkLink', title: 'failed', url: 'https://example.com/failed' } as CatalogAction)).ok).toBe(false);
    expect((await f.app.getSnapshot()).catalog).toEqual(before.catalog);
    expect(await readFile(f.file, 'utf8')).toBe(bytes);
    expect((await f.catalog({ type: 'bookmarkLink', title: 'retry', url: 'https://example.com/retry' } as CatalogAction)).ok).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
  });
  it('persists account identity and reference selection on restart without service collection writes', async () => {
    const f = await setup();
    await f.catalog({
      type: 'captureResourceRevision',
      workspaceId: 'taskflow-demo',
      runtimeResourceId: f.web.resourceId,
    } as CatalogAction);
    await f.catalog({ type: 'bookmarkResource', resourceId: f.web.catalogResourceId } as CatalogAction);
    await f.catalog({
      type: 'selectReference',
      workspaceId: 'taskflow-demo',
      resourceId: f.web.catalogResourceId,
      version: 1,
    } as CatalogAction);
    const before = await f.app.getSnapshot();
    await mkdir(path.join(f.root, 'chat'));
    await writeFile(path.join(f.root, 'chat', 'space-resources.json'), 'not read after migration');
    const restarted = new WorkbenchApplication(new FileWorkbenchRepository(f.file), f.runtime, vi.fn());
    expect((await restarted.getSnapshot()).catalog).toEqual(before.catalog);
    expect((await restarted.personalReferences([{ resourceId: f.web.catalogResourceId, version: 1 }])).resources[0]?.text).toBe('v1');
    expect((await restarted.getSnapshot()).workspaces[0]?.resources.every((resource) => resource.instanceId === null)).toBe(true);
  });
  it('bookmarks the successful native URL after A→B navigation and preserves A history across restart', async () => {
    const f = await setup();
    await f.catalog({
      type: 'captureResourceRevision',
      workspaceId: 'taskflow-demo',
      runtimeResourceId: f.web.resourceId,
    } as CatalogAction);
    f.page.url = 'https://example.com/B';
    f.page.documentGeneration++;
    const b = { ...snapshot('B'), page: { ...f.page }, requestedUrl: f.page.url, url: f.page.url };
    vi.mocked(f.runtime.captureResource).mockResolvedValue(b);
    expect(
      (
        await f.catalog({
          type: 'bookmarkRuntimeResource',
          workspaceId: 'taskflow-demo',
          runtimeResourceId: f.web.resourceId,
        } as CatalogAction)
      ).ok,
    ).toBe(true);
    const after = await f.app.getSnapshot();
    const id = after.workspaces[0]!.resources.find((r) => r.resourceId === f.web.resourceId)!.catalogResourceId!;
    expect(id).not.toBe(f.web.catalogResourceId);
    expect(after.catalog!.resources.find((r) => r.resourceId === id)?.descriptor).toEqual({ kind: 'web', url: f.page.url });
    expect(after.catalog!.library.map((r) => r.resourceId)).toContain(id);
    expect(
      (
        await f.catalog({
          type: 'captureResourceRevision',
          workspaceId: 'taskflow-demo',
          runtimeResourceId: f.web.resourceId,
        } as CatalogAction)
      ).ok,
    ).toBe(true);
    expect((await f.app.catalogRevision(id, 1)).text).toBe('B');
    expect((await f.app.catalogRevision(f.web.catalogResourceId, 1)).text).toBe('v1');
    const restarted = new WorkbenchApplication(new FileWorkbenchRepository(f.file), f.runtime, vi.fn());
    expect((await restarted.getSnapshot()).workspaces[0]!.resources.find((r) => r.resourceId === f.web.resourceId)?.catalogResourceId).toBe(
      id,
    );
  });
  it('keeps full account titles but bounds opened tab titles and advances only the target layout revision', async () => {
    const f = await setup();
    await f.catalog({ type: 'bookmarkLink', title: '长'.repeat(300), url: 'https://example.com/long' } as CatalogAction);
    const item = (await f.app.getSnapshot()).catalog!.resources.find((r) => r.title.length === 300)!;
    await f.catalog({ type: 'connectResource', workspaceId: 'taskflow-demo', resourceId: item.resourceId } as CatalogAction);
    const before = await f.app.getSnapshot();
    expect(
      (await f.catalog({ type: 'openCatalogResource', workspaceId: 'taskflow-demo', resourceId: item.resourceId } as CatalogAction)).ok,
    ).toBe(true);
    const after = await f.app.getSnapshot();
    expect(after.workspaces[0]!.revision).toBe(before.workspaces[0]!.revision + 1);
    expect(after.workspaces[0]!.tabs.find((t) => t.title.startsWith('长'))!.title).toHaveLength(200);
    expect(after.catalog!.resources.find((r) => r.resourceId === item.resourceId)!.title).toHaveLength(300);
  });
  it('passes selected v1 to runtime and durably freezes it while v2 and future selection change', async () => {
    const f = await setup();
    await f.catalog({
      type: 'captureResourceRevision',
      workspaceId: 'taskflow-demo',
      runtimeResourceId: f.web.resourceId,
    } as CatalogAction);
    await f.catalog({
      type: 'selectReference',
      workspaceId: 'taskflow-demo',
      resourceId: f.web.catalogResourceId,
      version: 1,
    } as CatalogAction);
    const session = (await f.app.getSnapshot()).workspaces[0]!.sessions[0]!;
    vi.mocked(f.runtime.send).mockResolvedValue({
      conversationId: session.sessionId,
      generation: 'g',
      turnId: 't',
      seq: 1,
      state: 'running',
      threadId: 'thread',
      messages: [],
      toolExecutions: [],
      warnings: [],
      cleanupPending: true,
      error: null,
    });
    await f.app.command({
      type: 'confirmTask',
      commandId: 'confirm',
      workspaceId: 'taskflow-demo',
      sessionId: session.sessionId,
      goal: 'read frozen',
      targetRef: null,
      appId: null,
      captureId: null,
    });
    const version = (await f.app.getSnapshot()).workspaces[0]!.sessions[0]!.taskVersions[0]!;
    expect(
      (
        await f.app.command({
          type: 'startRun',
          commandId: 'start',
          workspaceId: 'taskflow-demo',
          sessionId: session.sessionId,
          taskVersionId: version.taskVersionId,
        })
      ).ok,
    ).toBe(true);
    await vi.waitFor(() => expect(f.runtime.send).toHaveBeenCalledOnce());
    expect(vi.mocked(f.runtime.send).mock.calls[0]![3]!.resources[0]).toMatchObject({ version: 1, text: 'v1' });
    vi.mocked(f.runtime.captureResource).mockResolvedValue(snapshot('v2'));
    expect(
      (
        await f.catalog({
          type: 'captureResourceRevision',
          workspaceId: 'taskflow-demo',
          runtimeResourceId: f.web.resourceId,
        } as CatalogAction)
      ).ok,
    ).toBe(true);
    await f.catalog({
      type: 'selectReference',
      workspaceId: 'taskflow-demo',
      resourceId: f.web.catalogResourceId,
      version: 2,
    } as CatalogAction);
    const run = (await f.app.getSnapshot()).workspaces[0]!.runs[0]!;
    expect((await f.app.runReferences('taskflow-demo', run.runId))!.resources[0]).toMatchObject({ version: 1, text: 'v1' });
    expect(JSON.stringify(await f.app.getSnapshot())).not.toContain('"text":"v1"');
    const restarted = new WorkbenchApplication(new FileWorkbenchRepository(f.file), f.runtime, vi.fn());
    expect((await restarted.runReferences('taskflow-demo', run.runId))!.resources[0]).toMatchObject({ version: 1, text: 'v1' });
    expect(vi.mocked(f.runtime.send).mock.calls[0]![3]!.resources[0]!.version).toBe(1);
  });
  it.each(['count', 'json'] as const)('rejects %s reference budget before runtime.send', async (budget) => {
    const f = await setup();
    for (let i = 0; i < (budget === 'count' ? 17 : 1); i++) {
      f.page.url = 'https://example.com/budget/' + i;
      f.page.documentGeneration++;
      const capture = {
        ...snapshot(budget === 'json' ? '\u0000'.repeat(50000) : 'bounded'),
        page: { ...f.page },
        url: f.page.url,
        requestedUrl: f.page.url,
      };
      vi.mocked(f.runtime.captureResource).mockResolvedValue(capture);
      expect(
        (
          await f.catalog({
            type: 'captureResourceRevision',
            workspaceId: 'taskflow-demo',
            runtimeResourceId: f.web.resourceId,
          } as CatalogAction)
        ).ok,
      ).toBe(true);
      const current = (await f.app.getSnapshot()).workspaces[0]!.resources.find(
        (r) => r.resourceId === f.web.resourceId,
      )!.catalogResourceId!;
      await f.catalog({ type: 'selectReference', workspaceId: 'taskflow-demo', resourceId: current, version: 1 } as CatalogAction);
    }
    const session = (await f.app.getSnapshot()).workspaces[0]!.sessions[0]!;
    await f.app.command({
      type: 'confirmTask',
      commandId: 'confirm',
      workspaceId: 'taskflow-demo',
      sessionId: session.sessionId,
      goal: 'budget',
      targetRef: null,
      appId: null,
      captureId: null,
    });
    const version = (await f.app.getSnapshot()).workspaces[0]!.sessions[0]!.taskVersions[0]!;
    const result = await f.app.command({
      type: 'startRun',
      commandId: 'start',
      workspaceId: 'taskflow-demo',
      sessionId: session.sessionId,
      taskVersionId: version.taskVersionId,
    });
    expect(result.ok).toBe(false);
    expect(f.runtime.send).not.toHaveBeenCalled();
    expect((await f.app.getSnapshot()).workspaces[0]!.runs).toHaveLength(0);
  });

  it('carries a nonempty Main selection through the real service send seam for dynamic and personal sessions', async () => {
    const f = await setup();
    let finish!: (value: { confirmed: boolean; error: null; exitCode: number }) => void;
    const done = new Promise<{ confirmed: boolean; error: null; exitCode: number }>((resolve) => {
      finish = resolve;
    });
    const start = vi.fn((_: GuestStart) => ({
      done,
      close: async () => {
        finish({ confirmed: true, error: null, exitCode: 0 });
        return done;
      },
    }));
    const connection = {
      start,
      getStatus: () => ({ available: true }),
      getCleanupPending: () => false,
      shutdown: async () => undefined,
    } as unknown as SbxConnection;
    const chat = new CodexChat('', vi.fn(), connection);
    vi.mocked(f.runtime.registerSession).mockImplementation(async (sessionId, workspaceId) => chat.register(sessionId, workspaceId));
    vi.mocked(f.runtime.send).mockImplementation((id, text, scope, references) => chat.send(id, text, scope, references));
    await f.catalog({
      type: 'captureResourceRevision',
      workspaceId: 'taskflow-demo',
      runtimeResourceId: f.web.resourceId,
    } as CatalogAction);
    await f.catalog({ type: 'bookmarkResource', resourceId: f.web.catalogResourceId } as CatalogAction);
    await f.catalog({
      type: 'selectReference',
      workspaceId: 'taskflow-demo',
      resourceId: f.web.catalogResourceId,
      version: 1,
    } as CatalogAction);
    const session = (await f.app.getSnapshot()).workspaces[0]!.sessions[0]!;
    await f.app.command({
      type: 'confirmTask',
      commandId: 'confirm',
      workspaceId: 'taskflow-demo',
      sessionId: session.sessionId,
      goal: 'read',
      targetRef: null,
      appId: null,
      captureId: null,
    });
    const version = (await f.app.getSnapshot()).workspaces[0]!.sessions[0]!.taskVersions[0]!;
    await f.app.command({
      type: 'startRun',
      commandId: 'start',
      workspaceId: 'taskflow-demo',
      sessionId: session.sessionId,
      taskVersionId: version.taskVersionId,
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect((start.mock.calls[0]![0] as Extract<GuestStart, { mode: 'codex' }>).resourceBundle).toMatchObject({
      sessionId: session.sessionId,
      workspaceId: 'taskflow-demo',
      resources: [{ resourceId: f.web.catalogResourceId, version: 1, text: 'v1' }],
    });
    await chat.cancel(session.sessionId);
    await chat.send(
      'conv-personal-default',
      'read',
      undefined,
      await f.app.personalReferences([{ resourceId: f.web.catalogResourceId, version: 1 }]),
    );
    expect((start.mock.calls[1]![0] as Extract<GuestStart, { mode: 'codex' }>).resourceBundle).toMatchObject({
      sessionId: 'conv-personal-default',
      workspaceId: null,
      resources: [{ version: 1, text: 'v1' }],
    });
    await chat.shutdown();
  });

  it('opening A from the catalogue preserves a navigated B page and creates a separate A binding', async () => {
    const f = await setup();
    await f.catalog({
      type: 'captureResourceRevision',
      workspaceId: 'taskflow-demo',
      runtimeResourceId: f.web.resourceId,
    } as CatalogAction);
    f.page.url = 'https://example.com/B';
    f.page.documentGeneration++;
    expect(
      (await f.catalog({ type: 'openCatalogResource', workspaceId: 'taskflow-demo', resourceId: f.web.catalogResourceId } as CatalogAction))
        .ok,
    ).toBe(true);
    const resources = (await f.app.getSnapshot()).workspaces[0]!.resources.filter((r) => r.catalogResourceId === f.web.catalogResourceId);
    expect(resources).toHaveLength(2);
    expect(resources.find((r) => r.resourceId !== f.web.resourceId)?.url).toBe('https://example.com/');
    expect(f.page.url).toBe('https://example.com/B');
  });

  it('blocks unlink of an in-flight reference without an open runtime and preserves historical evidence after deletion', async () => {
    const f = await setup();
    await f.catalog({
      type: 'captureResourceRevision',
      workspaceId: 'taskflow-demo',
      runtimeResourceId: f.web.resourceId,
    } as CatalogAction);
    await f.catalog({
      type: 'selectReference',
      workspaceId: 'taskflow-demo',
      resourceId: f.web.catalogResourceId,
      version: 1,
    } as CatalogAction);
    const persisted = JSON.parse(await readFile(f.file, 'utf8'));
    const workspace = persisted.snapshot.workspaces[0];
    workspace.resources = workspace.resources.filter((r: { resourceId: string }) => r.resourceId !== f.web.resourceId);
    workspace.tabs = workspace.tabs.filter((t: { targetRef: { resourceId: string } }) => t.targetRef.resourceId !== f.web.resourceId);
    workspace.layout = { kind: 'pane', paneId: workspace.activePaneId, tabId: workspace.tabs[0].tabId };
    await writeFile(f.file, JSON.stringify(persisted));
    const app = new WorkbenchApplication(new FileWorkbenchRepository(f.file), f.runtime, vi.fn());
    const session = (await app.getSnapshot()).workspaces[0]!.sessions[0]!;
    const conversation = {
      conversationId: session.sessionId,
      generation: 'g',
      turnId: 't',
      seq: 1,
      state: 'running' as const,
      threadId: 'thread',
      messages: [],
      toolExecutions: [],
      warnings: [],
      cleanupPending: true,
      error: null,
    };
    vi.mocked(f.runtime.send).mockResolvedValue(conversation);
    await app.command({
      type: 'confirmTask',
      commandId: 'confirm',
      workspaceId: 'taskflow-demo',
      sessionId: session.sessionId,
      goal: 'read',
      targetRef: null,
      appId: null,
      captureId: null,
    });
    const version = (await app.getSnapshot()).workspaces[0]!.sessions[0]!.taskVersions[0]!;
    await app.command({
      type: 'startRun',
      commandId: 'start',
      workspaceId: 'taskflow-demo',
      sessionId: session.sessionId,
      taskVersionId: version.taskVersionId,
    });
    await vi.waitFor(() => expect(f.runtime.send).toHaveBeenCalledOnce());
    const action = async (type: 'disconnectResource' | 'deleteResource') =>
      app.catalogCommand({
        type,
        commandId: crypto.randomUUID(),
        expectedCatalogRevision: (await app.getSnapshot()).catalog!.revision,
        resourceId: f.web.catalogResourceId,
        ...(type === 'disconnectResource' ? { workspaceId: 'taskflow-demo' } : {}),
      } as CatalogAction);
    expect((await action('disconnectResource')).ok).toBe(false);
    app.onConversation({ ...conversation, seq: 2, state: 'idle', cleanupPending: false });
    await app.getSnapshot();
    expect((await action('disconnectResource')).ok).toBe(true);
    expect((await action('deleteResource')).ok).toBe(true);
    const run = (await app.getSnapshot()).workspaces[0]!.runs[0]!;
    expect((await app.runReferences('taskflow-demo', run.runId))!.resources[0]!.text).toBe('v1');
    const restarted = new WorkbenchApplication(new FileWorkbenchRepository(f.file), f.runtime, vi.fn());
    expect((await restarted.runReferences('taskflow-demo', run.runId))!.resources[0]!.text).toBe('v1');
  });
});

it('explicitly closes only the target web instance before unlink, while preserving other-space connections', async () => {
  const f = await setup();
  await f.app.command({
    type: 'browserAction',
    commandId: 'ensure-stop-browser',
    workspaceId: 'taskflow-demo',
    resourceId: f.web.resourceId,
    action: 'navigate',
    url: snapshot().url,
  });
  f.runtime.releaseResource = vi.fn(async () => {});
  await f.catalog({ type: 'connectResource', workspaceId: 'taskflow-demo', resourceId: f.web.catalogResourceId });
  await f.app.command({ type: 'createWorkspace', commandId: 'new-B', workspaceId: 'B', name: 'B' });
  await f.catalog({ type: 'connectResource', workspaceId: 'B', resourceId: f.web.catalogResourceId });
  const state = await f.app.getSnapshot();
  const tab = state.workspaces
    .find((workspace) => workspace.workspaceId === 'taskflow-demo')!
    .tabs.find((tab) => tab.targetRef.resourceId === f.web.resourceId)!;
  await f.app.command({ type: 'closeTab', commandId: 'close-web', workspaceId: 'taskflow-demo', tabId: tab.tabId });
  const resource = (await f.app.getSnapshot()).workspaces
    .find((workspace) => workspace.workspaceId === 'taskflow-demo')!
    .resources.find((resource) => resource.resourceId === f.web.resourceId)!;
  const stopped = await f.app.command({
    type: 'stopInstance',
    commandId: 'stop-web',
    workspaceId: 'taskflow-demo',
    resourceId: resource.resourceId,
    instanceId: resource.instanceId!,
  });
  expect(stopped.ok, JSON.stringify(stopped.ok ? null : stopped.error)).toBe(true);
  expect(f.runtime.releaseResource).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId: 'taskflow-demo', resourceId: resource.resourceId, instanceId: resource.instanceId }),
  );
  expect((await f.catalog({ type: 'disconnectResource', workspaceId: 'taskflow-demo', resourceId: f.web.catalogResourceId })).ok).toBe(
    true,
  );
  expect(
    (await f.app.getSnapshot())
      .catalog!.links.filter((link) => link.resourceId === f.web.catalogResourceId)
      .map((link) => link.workspaceId),
  ).toEqual(['B']);
});

it('migrates a concrete document path and reopens it in its authorized environment in another space', async () => {
  const f = await setup();
  const persisted = JSON.parse(await readFile(f.file, 'utf8'));
  const old = persisted.snapshot;
  const file = old.workspaces
    .find((workspace: { workspaceId: string }) => workspace.workspaceId === 'taskflow-demo')
    .resources.find((resource: { resourceId: string }) => resource.resourceId === f.web.resourceId);
  for (const tab of old.workspaces.find((workspace: { workspaceId: string }) => workspace.workspaceId === 'taskflow-demo').tabs)
    if (tab.targetRef.resourceId === f.web.resourceId) tab.targetRef.kind = 'file';
  file.kind = 'file';
  file.url = 'nested/saved.txt';
  file.instanceId = null;
  delete file.catalogResourceId;
  await writeFile(f.file, JSON.stringify({ schemaVersion: 2, snapshot: old }));
  f.runtime.environmentsList = vi.fn(async () => [
    {
      environmentId: 'local' as const,
      kind: 'local' as const,
      state: 'configured' as const,
      label: 'Local',
      capabilities: { browser: true, files: true, terminal: true },
      reason: null,
    },
  ]);
  const app = new WorkbenchApplication(new FileWorkbenchRepository(f.file), f.runtime, vi.fn());
  await app.getSnapshot();
  await app.environments();
  await app.command({ type: 'createWorkspace', commandId: 'new-doc-B', workspaceId: 'doc-B', name: 'B' });
  const item = (await app.getSnapshot()).catalog!.resources.find((resource) => resource.descriptor.kind === 'document')!;
  expect(item.descriptor).toEqual({ kind: 'document', environmentId: 'local', path: 'nested/saved.txt' });
  for (const type of ['connectResource', 'openCatalogResource'] as const)
    expect(
      (
        await app.catalogCommand({
          type,
          commandId: type,
          expectedCatalogRevision: (await app.getSnapshot()).catalog!.revision,
          workspaceId: 'doc-B',
          resourceId: item.resourceId,
        })
      ).ok,
    ).toBe(true);
  expect(
    (await app.getSnapshot()).workspaces
      .find((workspace) => workspace.workspaceId === 'doc-B')!
      .resources.find((resource) => resource.catalogResourceId === item.resourceId),
  ).toMatchObject({ environmentId: 'local', url: 'nested/saved.txt', kind: 'file' });
});

it('allows a metadata favorite when body capture fails, without creating a body revision', async () => {
  const f = await setup();
  f.runtime.captureResource = vi.fn(async () => {
    throw new Error('controlled body failure');
  });
  await expect(
    f.catalog({ type: 'captureResourceRevision', workspaceId: 'taskflow-demo', runtimeResourceId: f.web.resourceId }),
  ).rejects.toThrow('controlled body failure');
  f.runtime.browserState = () =>
    ({ page: f.page, loading: false, loadError: { code: -2, description: 'controlled capture error', url: f.page.url } }) as PreviewState;
  expect((await f.catalog({ type: 'bookmarkRuntimeResource', workspaceId: 'taskflow-demo', runtimeResourceId: f.web.resourceId })).ok).toBe(
    true,
  );
  const state = await f.app.getSnapshot();
  expect(state.catalog!.library.some((entry) => entry.resourceId === f.web.catalogResourceId)).toBe(true);
  expect(state.catalog!.resources.find((item) => item.resourceId === f.web.catalogResourceId)!.versions).toEqual([]);
});

describe('unlink preserves runtime bindings that durable session and task records reference', () => {
  type Fixture = Awaited<ReturnType<typeof setup>>;
  const demo = async (f: Fixture) => (await f.app.getSnapshot()).workspaces.find((workspace) => workspace.workspaceId === 'taskflow-demo')!;
  async function release(f: Fixture, resourceId: string) {
    f.runtime.releaseResource = vi.fn(async () => {});
    const tab = (await demo(f)).tabs.find((tab) => tab.targetRef.resourceId === resourceId);
    if (tab) await f.app.command({ type: 'closeTab', commandId: crypto.randomUUID(), workspaceId: 'taskflow-demo', tabId: tab.tabId });
    const resource = (await demo(f)).resources.find((resource) => resource.resourceId === resourceId)!;
    if (resource.instanceId)
      expect(
        (
          await f.app.command({
            type: 'stopInstance',
            commandId: crypto.randomUUID(),
            workspaceId: 'taskflow-demo',
            resourceId,
            instanceId: resource.instanceId,
          })
        ).ok,
      ).toBe(true);
    return resource;
  }
  const unlink = (f: Fixture, resourceId: string) => f.catalog({ type: 'disconnectResource', workspaceId: 'taskflow-demo', resourceId });
  const restart = (f: Fixture) => new WorkbenchApplication(new FileWorkbenchRepository(f.file), f.runtime, vi.fn()).getSnapshot();

  it('rejects unlinking a session task target until the target changes, and every outcome reloads', async () => {
    const f = await setup();
    await release(f, f.web.resourceId);
    const sessionId = (await demo(f)).sessions[0]!.sessionId;
    const target = { kind: 'web' as const, resourceId: f.web.resourceId };
    await f.app.command({ type: 'saveTaskTarget', commandId: 'target', workspaceId: 'taskflow-demo', sessionId, targetRef: target });

    const rejected = await unlink(f, f.web.catalogResourceId);
    expect(rejected.ok).toBe(false);
    expect(rejected.ok ? null : rejected.error.message).toContain('会话任务目标');
    expect((await demo(f)).resources.some((resource) => resource.resourceId === f.web.resourceId)).toBe(true);
    expect((await f.app.getSnapshot()).catalog!.links.some((link) => link.resourceId === f.web.catalogResourceId)).toBe(true);
    // The rejected write leaves ordinary commands usable and the stored state loadable.
    expect((await f.app.command({ type: 'saveDraft', commandId: 'draft', workspaceId: 'taskflow-demo', sessionId, draft: 'x' })).ok).toBe(
      true,
    );
    await expect(restart(f)).resolves.toBeTruthy();

    await f.app.command({ type: 'saveTaskTarget', commandId: 'untarget', workspaceId: 'taskflow-demo', sessionId, targetRef: null });
    expect((await unlink(f, f.web.catalogResourceId)).ok).toBe(true);
    const reloaded = await restart(f);
    expect(reloaded.workspaces[0]!.resources.some((resource) => resource.resourceId === f.web.resourceId)).toBe(false);
  });

  it('rejects unlinking a resource frozen in a confirmed task version and keeps the history readable after restart', async () => {
    const f = await setup();
    const terminal = (await demo(f)).resources.find((resource) => resource.kind === 'terminal')!;
    await release(f, terminal.resourceId);
    const sessionId = (await demo(f)).sessions[0]!.sessionId;
    const confirmed = await f.app.command({
      type: 'confirmTask',
      commandId: 'confirm-terminal',
      workspaceId: 'taskflow-demo',
      sessionId,
      goal: 'inspect terminal',
      targetRef: { kind: 'terminal', resourceId: terminal.resourceId },
      appId: null,
      captureId: null,
    });
    expect(confirmed.ok).toBe(true);

    const rejected = await unlink(f, terminal.catalogResourceId!);
    expect(rejected.ok).toBe(false);
    expect(rejected.ok ? null : rejected.error.message).toContain('任务版本或执行记录');
    const reloaded = await restart(f);
    const workspace = reloaded.workspaces.find((item) => item.workspaceId === 'taskflow-demo')!;
    expect(workspace.sessions[0]!.taskVersions[0]!.targetRef).toEqual({ kind: 'terminal', resourceId: terminal.resourceId });
    expect(workspace.resources.some((resource) => resource.resourceId === terminal.resourceId)).toBe(true);
  });
});
