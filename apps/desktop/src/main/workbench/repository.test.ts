import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { WorkbenchSnapshotSchema, guestAppCwd, type WorkbenchSnapshot } from '@wsl/protocol';
import { FileWorkbenchRepository } from './repository';
import { catalogForTestSnapshot } from './catalog-test-fixture';
import { validateSnapshot } from './application';
describe('workbench persistence boundary', () => {
  it('rejects corrupt and future schema without overwriting original bytes', async () => {
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'wsl-workbench-')), 'state.json');
    const repository = new FileWorkbenchRepository(file);
    for (const content of ['{invalid', '{"schemaVersion":99,"snapshot":{}}']) {
      await writeFile(file, content);
      await expect(repository.load()).rejects.toThrow();
      expect(await readFile(file, 'utf8')).toBe(content);
    }
  });
  it('treats only a missing file as new workspace', async () => {
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'wsl-workbench-')), 'missing.json');
    expect(await new FileWorkbenchRepository(file).load()).toBeNull();
  });
});

/*
 * OPS-1 R1 / O05g：schema 4 → 5。schema 5 显式保存 W4 的 harnessSelection、会话工程选择 taskProject 与标签 autoTitle；
 * 旧文件原样另存备份并原子替换；旧会话工程选择为空、旧标签为手动标题，历史任务版本不推断、不回填；未知较新版本拒绝并保留原文件。
 */
const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('missing fixture value');
  return value;
};
const appId = '30000000-0000-4000-8000-000000000001';
const projectId = '30000000-0000-4000-8000-000000000002';
const profileId = '30000000-0000-4000-8000-000000000003';
function fixtureSnapshot(): WorkbenchSnapshot {
  const app = { appId, workspaceId: 'w', projectId, name: '标准应用', description: '旧说明', revision: 3 };
  const resource = (resourceId: string, kind: 'web' | 'session', extra: Record<string, unknown> = {}) => ({
    resourceId,
    environmentId: kind === 'web' ? 'local' : null,
    kind,
    title: resourceId,
    url: kind === 'web' ? 'https://example.com/' + resourceId : null,
    instanceId: null,
    generation: 1,
    preview: null,
    terminal: null,
    unavailableReason: null,
    ...extra,
  });
  const version = (n: number, extra: Record<string, unknown>) => ({
    taskVersionId: `v${n}-` + randomUUID(),
    version: n,
    workspaceId: 'w',
    sessionId: 's1',
    goal: `历史任务 ${n}`,
    targetRef: null,
    capture: null,
    appTarget: null,
    captureBinding: null,
    confirmedAt: '2026-10-20T00:00:00.000Z',
    acceptance: ['验收'],
    allowedScopes: ['src'],
    ...extra,
  });
  return WorkbenchSnapshotSchema.parse({
    appInstanceId: 'old-app',
    activeWorkspaceId: 'w',
    seq: 3,
    storageError: null,
    notificationReadReceipts: [],
    workspaces: [
      {
        workspaceId: 'w',
        name: '旧空间',
        revision: 4,
        app,
        managedApp: {
          workspaceId: 'w',
          projectId,
          environmentId: 'sandbox',
          appInstanceId: null,
          state: 'stopped',
          url: null,
          guestCwd: guestAppCwd(projectId),
          error: null,
          cleanupConfirmed: true,
        },
        tabs: [
          { tabId: 'tab-web', title: '页面', pinned: false, group: null, targetRef: { kind: 'web', resourceId: 'web' } },
          { tabId: 'tab-app', title: '标准应用', pinned: true, group: '开发', targetRef: { kind: 'web', resourceId: 'app-page' } },
          { tabId: 'tab-s1', title: '会话', pinned: false, group: null, targetRef: { kind: 'session', resourceId: 'session-1' } },
          { tabId: 'tab-s2', title: '会话 2', pinned: false, group: null, targetRef: { kind: 'session', resourceId: 'session-2' } },
        ],
        resources: [
          resource('web', 'web'),
          resource('app-page', 'web', { environmentId: 'sandbox', appProjectId: projectId, url: null }),
          resource('session-1', 'session'),
          resource('session-2', 'session'),
        ],
        layout: { kind: 'pane', paneId: 'pane', tabId: 'tab-web' },
        activePaneId: 'pane',
        sessions: [
          {
            sessionId: 's1',
            resourceId: 'session-1',
            title: '会话',
            draft: '保留的草稿',
            conversation: null,
            context: null,
            contextTarget: null,
            taskTargetRef: { kind: 'web', resourceId: 'web' },
            contextApplicability: 'unknown',
            taskVersions: [
              version(1, {}),
              version(2, { targetRef: { kind: 'web', resourceId: 'app-page' }, appTarget: { ...app, guestCwd: guestAppCwd(projectId) } }),
            ],
            harnessSelection: { harnessId: 'claude-code', profileId },
          },
          {
            sessionId: 's2',
            resourceId: 'session-2',
            title: '会话 2',
            draft: '',
            conversation: null,
            context: null,
            contextTarget: null,
            taskTargetRef: null,
            contextApplicability: 'unknown',
            taskVersions: [],
          },
        ],
        runs: [],
        theme: 'warm',
      },
    ],
  });
}
/** 一个真实的 schema 4 文件：W4 尖端的形状，没有 taskProject / taskProjectDecided 与 autoTitle（s2 为 W4 之前写入、缺 harnessSelection 的会话）。 */
async function writeSchema4(file: string) {
  const snapshot = fixtureSnapshot();
  const catalog = await catalogForTestSnapshot(snapshot);
  const business = JSON.parse(JSON.stringify(snapshot)) as {
    workspaces: Array<{ tabs: Array<Record<string, unknown>>; sessions: Array<Record<string, unknown>> }>;
  };
  for (const workspace of business.workspaces) {
    for (const tab of workspace.tabs) delete tab['autoTitle'];
    for (const session of workspace.sessions) {
      delete session['taskProject'];
      delete session['taskProjectDecided'];
    }
    const legacy = workspace.sessions[1];
    if (legacy) delete legacy['harnessSelection'];
  }
  const bytes = JSON.stringify({ schemaVersion: 4, snapshot: business, catalog });
  await writeFile(file, bytes);
  return { bytes, snapshot, catalog, source: business };
}
const tempFile = async (prefix: string) => path.join(await mkdtemp(path.join(os.tmpdir(), prefix)), 'workbench.json');

describe('workbench schema 5 (OPS-1 R1)', () => {
  it('migrates a schema 4 file: empty project selection, manual tab titles, harnessSelection and history unchanged', async () => {
    const file = await tempFile('wsl-schema5-');
    const { bytes, source } = await writeSchema4(file);
    const repository = new FileWorkbenchRepository(file);
    const loaded = required(await repository.load());
    expect(repository.migrationPending).toBe(true);
    const workspace = required(loaded.workspaces[0]);
    // 旧标签一律为手动标题模式；其余标签字段原样保留。
    expect(workspace.tabs.map((tab) => tab.autoTitle)).toEqual([false, false, false, false]);
    expect(workspace.tabs.map(({ autoTitle: _autoTitle, ...tab }) => tab)).toEqual(required(source.workspaces[0]).tabs);
    // 空间有 App、历史版本也绑定过工程，旧会话的工程选择仍为空：不推断、不回填。
    expect(workspace.sessions.map((session) => session.taskProject)).toEqual([null, null]);
    // 旧会话的工程开关“尚未决定”：之后首次采集受管 App 页面时才自动开启。
    expect(workspace.sessions.map((session) => session.taskProjectDecided)).toEqual([false, false]);
    expect(required(workspace.sessions[0]).harnessSelection).toEqual({ harnessId: 'claude-code', profileId });
    expect(required(workspace.sessions[1]).harnessSelection).toBeNull();
    expect(required(workspace.sessions[0]).taskVersions).toEqual(required(required(source.workspaces[0]).sessions[0])['taskVersions']);
    expect(required(workspace.sessions[0]).draft).toBe('保留的草稿');
    expect(required(workspace.sessions[0]).taskTargetRef).toEqual({ kind: 'web', resourceId: 'web' });
    validateSnapshot(loaded);
    // 原子替换为 schema 5；原始字节另存为只读备份（不覆盖），不留下临时文件。
    await repository.save(loaded, await repository.loadCatalog(loaded));
    const stored = JSON.parse(await readFile(file, 'utf8')) as {
      schemaVersion: number;
      snapshot: { workspaces: Array<{ tabs: Array<Record<string, unknown>>; sessions: Array<Record<string, unknown>> }> };
    };
    expect(stored.schemaVersion).toBe(5);
    expect(await readFile(file + '.legacy-schema-4.json', 'utf8')).toBe(bytes);
    expect((await readdir(path.dirname(file))).filter((name) => name.endsWith('.pending'))).toEqual([]);
    // schema 5 显式写出这三个字段，而不是依赖读取时的默认值。
    const savedWorkspace = required(stored.snapshot.workspaces[0]);
    expect(savedWorkspace.tabs.every((tab) => tab['autoTitle'] === false)).toBe(true);
    expect(
      savedWorkspace.sessions.map((session) => [session['taskProject'], session['taskProjectDecided'], session['harnessSelection']]),
    ).toEqual([
      [null, false, { harnessId: 'claude-code', profileId }],
      [null, false, null],
    ]);
    const reloaded = new FileWorkbenchRepository(file);
    expect(await reloaded.load()).toEqual(loaded);
    expect(reloaded.migrationPending).toBe(false);
  });
  it('round-trips schema 5 project selection, decision marker and title mode', async () => {
    const file = await tempFile('wsl-schema5-roundtrip-');
    const { bytes } = await writeSchema4(file);
    const repository = new FileWorkbenchRepository(file);
    const loaded = required(await repository.load());
    const workspace = required(loaded.workspaces[0]);
    required(workspace.sessions[1]).taskProject = { appId, projectId };
    required(workspace.sessions[1]).taskProjectDecided = true;
    required(workspace.sessions[0]).taskProjectDecided = true;
    required(workspace.tabs[0]).autoTitle = true;
    const catalog = await repository.loadCatalog(loaded);
    await repository.save(loaded, catalog);
    const first = await readFile(file, 'utf8');
    const restored = new FileWorkbenchRepository(file);
    const again = required(await restored.load());
    expect(required(again.workspaces[0]).sessions.map((session) => session.taskProject)).toEqual([null, { appId, projectId }]);
    expect(required(again.workspaces[0]).sessions.map((session) => session.taskProjectDecided)).toEqual([true, true]);
    expect(required(again.workspaces[0]).tabs.map((tab) => tab.autoTitle)).toEqual([true, false, false, false]);
    expect(restored.migrationPending).toBe(false);
    await restored.save(again, await restored.loadCatalog(again));
    expect(await readFile(file, 'utf8')).toBe(first);
    expect(await readFile(file + '.legacy-schema-4.json', 'utf8')).toBe(bytes);
    expect((await readdir(path.dirname(file))).filter((name) => name.includes('legacy-schema-5'))).toEqual([]);
  });
  it('refuses unknown newer versions and incomplete schema 5 bodies without touching the file', async () => {
    const file = await tempFile('wsl-schema5-future-');
    await writeSchema4(file);
    const repository = new FileWorkbenchRepository(file);
    const loaded = required(await repository.load());
    await repository.save(loaded, await repository.loadCatalog(loaded));
    const valid = JSON.parse(await readFile(file, 'utf8')) as {
      schemaVersion: number;
      snapshot: { workspaces: Array<{ tabs: Array<Record<string, unknown>>; sessions: Array<Record<string, unknown>> }> };
    };
    const future = JSON.stringify({ ...valid, schemaVersion: 6 });
    const withoutProject = structuredClone(valid);
    for (const session of required(withoutProject.snapshot.workspaces[0]).sessions) delete session['taskProject'];
    const withoutTitleMode = structuredClone(valid);
    for (const tab of required(withoutTitleMode.snapshot.workspaces[0]).tabs) delete tab['autoTitle'];
    const withoutHarness = structuredClone(valid);
    for (const session of required(withoutHarness.snapshot.workspaces[0]).sessions) delete session['harnessSelection'];
    const withoutDecision = structuredClone(valid);
    for (const session of required(withoutDecision.snapshot.workspaces[0]).sessions) delete session['taskProjectDecided'];
    // schema 5 会话的未知字段拒绝，不静默丢弃。
    const unknownKey = structuredClone(valid);
    required(required(unknownKey.snapshot.workspaces[0]).sessions[0])['bogus'] = true;
    // schema 4 不能携带 schema 5 字段（不是“旧文件 + 默认值”）：标签的 autoTitle、会话的 taskProject / taskProjectDecided 都拒绝。
    const forgedV4 = JSON.stringify({ ...valid, schemaVersion: 4 });
    const v4Shape = () => {
      const copy = structuredClone(valid);
      copy.schemaVersion = 4;
      for (const workspace of copy.snapshot.workspaces) {
        for (const tab of workspace.tabs) delete tab['autoTitle'];
        for (const session of workspace.sessions) {
          delete session['taskProject'];
          delete session['taskProjectDecided'];
        }
      }
      return copy;
    };
    const v4WithProject = v4Shape();
    required(required(v4WithProject.snapshot.workspaces[0]).sessions[0])['taskProject'] = { appId, projectId };
    const v4WithDecision = v4Shape();
    required(required(v4WithDecision.snapshot.workspaces[0]).sessions[0])['taskProjectDecided'] = false;
    // 对照：去掉这些字段后同一份正文是合法的 schema 4。
    await writeFile(file, JSON.stringify(v4Shape()));
    expect(await new FileWorkbenchRepository(file).load()).not.toBeNull();
    for (const bytes of [
      future,
      JSON.stringify(withoutProject),
      JSON.stringify(withoutTitleMode),
      JSON.stringify(withoutHarness),
      JSON.stringify(withoutDecision),
      JSON.stringify(unknownKey),
      forgedV4,
      JSON.stringify(v4WithProject),
      JSON.stringify(v4WithDecision),
    ]) {
      await writeFile(file, bytes);
      const reader = new FileWorkbenchRepository(file);
      await expect(reader.load()).rejects.toThrow();
      expect(await readFile(file, 'utf8')).toBe(bytes);
    }
  });
  it('never overwrites an unknown newer file on save, with or without a prior failed load', async () => {
    const file = await tempFile('wsl-schema5-future-save-');
    await writeSchema4(file);
    const migrated = new FileWorkbenchRepository(file);
    const loaded = required(await migrated.load());
    const catalog = await migrated.loadCatalog(loaded);
    await migrated.save(loaded, catalog);
    const valid = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const future = JSON.stringify({ ...valid, schemaVersion: 6 });
    await writeFile(file, future);
    // 从未加载过的仓库：保存前读取到未知版本，拒绝并保留原字节。
    await expect(new FileWorkbenchRepository(file).save(loaded, catalog)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(future);
    // 加载失败后的仓库同样不覆盖。
    const failed = new FileWorkbenchRepository(file);
    await expect(failed.load()).rejects.toThrow();
    await expect(failed.save(loaded, catalog)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(future);
    expect((await readdir(path.dirname(file))).filter((name) => name.includes('legacy-schema-6'))).toEqual([]);
  });
  it('keeps the first migration backup immutable and refuses a conflicting backup without touching either file', async () => {
    const file = await tempFile('wsl-schema5-backup-');
    const { bytes } = await writeSchema4(file);
    const first = new FileWorkbenchRepository(file);
    const loaded = required(await first.load());
    await first.save(loaded, await first.loadCatalog(loaded));
    const backup = file + '.legacy-schema-4.json';
    const before = await stat(backup);
    expect(before.mode & 0o777).toBe(0o400);
    // 再次从同一份 schema 4 字节迁移（例如恢复了旧文件）：已有备份内容相同，不重写、不替换。
    await writeFile(file, bytes);
    const again = new FileWorkbenchRepository(file);
    const reloaded = required(await again.load());
    await again.save(reloaded, await again.loadCatalog(reloaded));
    const after = await stat(backup);
    expect([after.ino, after.mtimeMs, after.mode & 0o777]).toEqual([before.ino, before.mtimeMs, 0o400]);
    expect(await readFile(backup, 'utf8')).toBe(bytes);
    expect((JSON.parse(await readFile(file, 'utf8')) as { schemaVersion: number }).schemaVersion).toBe(5);
    // 已有备份与来源不一致：迁移被拒绝，原 schema 4 文件与已有备份都不改动。
    const other = await tempFile('wsl-schema5-backup-conflict-');
    const { bytes: source } = await writeSchema4(other);
    await writeFile(other + '.legacy-schema-4.json', 'another legacy source');
    const conflicted = new FileWorkbenchRepository(other);
    const pending = required(await conflicted.load());
    await expect(conflicted.save(pending, await conflicted.loadCatalog(pending))).rejects.toThrow('未改动');
    expect(await readFile(other, 'utf8')).toBe(source);
    expect(await readFile(other + '.legacy-schema-4.json', 'utf8')).toBe('another legacy source');
  });
});
