import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  isMotaExcludedName,
  isMotaSourcePath,
  MOTA_ROOT_DIRS,
  SetupSnapshotSchema,
  type PaneLayout,
  type MotaEditorBridge,
  type MotaEditorReadInput,
  type MotaEditorReadResult,
  type MotaEditorSaveInput,
} from '../packages/protocol/src';
import { chooseImportSource } from './edu-import-fixture';
import { launchApp, target, workspaceSnapshot, workshopNavigate } from './helpers';

const exec = promisify(execFile);
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const workspaceId = 'taskflow-demo';
const floorPath = 'project/floors/MT1.js';
const configPath = '_server/config.json';
type AppPage = 'game' | 'editor';
type ProcessIdentity = { pid: number; startTime: string };
type MotaCore = {
  flags: { startUsingCanvas: boolean };
  status: { floorId: string; hero: { hp: number; loc: { x: number; y: number } }; route: string[]; lockControl: boolean };
  getBlockNumber(x: number, y: number, floorId: string): number | null;
};
const Floor = z.object({ floorId: z.literal('MT1'), map: z.array(z.array(z.number().int())) }).passthrough();
const parseFloor = (bytes: Buffer) =>
  Floor.parse(
    JSON.parse(
      bytes
        .toString('utf8')
        .replace(/^\s*main\.floors\.MT1\s*=\s*/, '')
        .replace(/;?\s*$/, ''),
    ),
  );
const GuestFileAudit = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  base64: z.string().max(349528),
  mode: z.number(),
});
const GuestAudit = GuestFileAudit.extend({
  config: GuestFileAudit.nullable(),
  processes: z.array(z.object({ pid: z.number().int(), startTime: z.string() })),
  expectedRemaining: z.array(z.object({ pid: z.number().int(), startTime: z.string() })),
});
const targetSnapshot = (audit: z.infer<typeof GuestAudit>) => ({
  floor: { sha256: audit.sha256, base64: audit.base64, mode: audit.mode },
  config: audit.config,
});
const auditSummary = (audit: z.infer<typeof GuestAudit>) => ({
  ...audit,
  base64: undefined,
  config: audit.config ? { ...audit.config, base64: undefined } : null,
});
const Ports = z.array(z.object({ sandbox_port: z.number(), host_port: z.number(), host_ip: z.string(), protocol: z.string() }));
const orderedPorts = (ports: z.infer<typeof Ports>) =>
  [...ports].sort(
    (a, b) =>
      a.sandbox_port - b.sandbox_port ||
      a.host_port - b.host_port ||
      a.host_ip.localeCompare(b.host_ip) ||
      a.protocol.localeCompare(b.protocol),
  );

async function bounded<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function deniedEditorSave(view: Page, input: MotaEditorSaveInput) {
  // A closed document, missing bridge or transport error fails outside the save rejection check.
  expect(view.url()).toBe('wsl-editor://mota/index.html');
  expect(await view.evaluate(() => typeof Reflect.get(window, 'motaEditor'))).toBe('object');
  const rejection = await view.evaluate(async (request) => {
    try {
      await (window as unknown as { motaEditor: MotaEditorBridge }).motaEditor.save(request);
      return 'resolved';
    } catch (error) {
      const match = /^Error: (?:Error invoking remote method 'mota-editor:save': Error: )?(denied|revoked):/.exec(String(error));
      return match?.[1] ?? 'unexpected-rejection';
    }
  }, input);
  expect(['denied', 'revoked']).toContain(rejection);
  return { file: input.file, requestId: input.requestId, sessionIndex: input.sessionIndex, rejection };
}

async function untrustedSaveAttempts(view: Page) {
  return view.evaluate(async () => {
    const old = await fetch('/editor.html', { cache: 'no-store' });
    const html = await old.text();
    const nonce = /data-wsl-editor-session="([a-f0-9]{48})"/.exec(html)?.[1];
    const statuses = [];
    for (const file of ['project/floors/MT1.js', '_server/config.json']) {
      const content = file.endsWith('.js') ? 'main.floors.MT1 = {"floorId":"MT1","map":[[9]]};\n' : '{"untrusted":true}\n';
      const response = await fetch('/writeFile', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'X-WSL-Editor-Session': nonce ?? 'a'.repeat(48) },
        body: new URLSearchParams({ name: file, type: 'base64', value: btoa(content) }),
      });
      statuses.push({ file, status: response.status, body: await response.text() });
      window.postMessage({ type: 'mota-editor:save', file, content }, '*');
    }
    // Observe the message queue after both attacks; no fabricated product response or delay-based success.
    await new Promise<void>((resolve) => {
      const marker = crypto.randomUUID();
      const listener = (event: MessageEvent) => {
        if (event.source !== window || event.data !== marker) return;
        window.removeEventListener('message', listener);
        resolve();
      };
      window.addEventListener('message', listener);
      window.postMessage(marker, '*');
    });
    return {
      oldStatus: old.status,
      nonceDisclosed: !!nonce,
      editor: typeof Reflect.get(window, 'motaEditor'),
      studio: typeof window.studio,
      statuses,
    };
  });
}

/** Only admitted source paths; credentials, source servers and private data are never read by this audit. */
async function selectedSourceDigest(root: string) {
  const entries: Array<{ path: string; mode: number; sha256: string }> = [];
  const walk = async (relative: string) => {
    const info = await lstat(path.join(root, relative));
    if (info.isSymbolicLink()) throw new Error('source audit refuses symlinks');
    if (info.isDirectory()) {
      for (const name of (await readdir(path.join(root, relative))).sort()) {
        if (isMotaExcludedName(name)) continue;
        const child = relative ? relative + '/' + name : name;
        if (MOTA_ROOT_DIRS.includes(child) || isMotaSourcePath(child)) await walk(child);
      }
    } else if (info.isFile() && info.nlink === 1) {
      entries.push({ path: relative, mode: info.mode, sha256: sha256(await readFile(path.join(root, relative))) });
    } else throw new Error('source audit refuses nonregular or multiply linked files');
  };
  await walk('');
  return sha256(JSON.stringify(entries));
}

function activeTab(layout: PaneLayout, paneId: string): string | null {
  if (layout.kind === 'pane') return layout.paneId === paneId ? layout.tabId : null;
  return activeTab(layout.first, paneId) ?? activeTab(layout.second, paneId);
}

test('real Mota import, two native resources, editor save, fresh-game potion and owned stop/restart', async () => {
  test.skip(process.env['WSL_MOTA_LIVE'] !== '1', 'explicit existing-guest Mota authorization required; no model or Azure calls');
  test.setTimeout(600_000);
  const sourceInput = process.env['WSL_MOTA_SOURCE_ROOT'];
  const expectedSha = process.env['WSL_MOTA_EXPECTED_SHA256'];
  const evidenceRoot = process.env['WSL_MOTA_EVIDENCE'];
  const profile = process.env['WSL_MOTA_PROFILE'];
  const runtimeFile = process.env['WSL_MOTA_RUNTIME'];
  const runtimeSha = process.env['WSL_MOTA_RUNTIME_SHA256'];
  const sandbox = process.env['WSL_SBX_NAME'];
  const binary = process.env['WSL_SBX_BIN'] ?? '/opt/homebrew/bin/sbx';
  if (!sourceInput || !evidenceRoot || !profile || !/^[a-f0-9]{64}$/.test(expectedSha ?? ''))
    throw new Error('explicit copied source/digest and fresh profile/evidence required');
  if (![sourceInput, evidenceRoot, profile, binary].every(path.isAbsolute) || sandbox !== 'wsl-sbx-smoke-20261006')
    throw new Error('this acceptance owns only the explicitly authorized existing smoke sandbox and absolute paths');
  if (['WSL_OBSERVATION_ROOT', 'WSL_SSH_HOST', 'WSL_SSH_ROOT'].some((key) => process.env[key]))
    throw new Error('unrelated host/SSH environment overrides must be cleared for this owned guest acceptance');
  if (profile === evidenceRoot || profile.startsWith(evidenceRoot + path.sep) || evidenceRoot.startsWith(profile + path.sep))
    throw new Error('private Electron profile must remain outside evidence');
  const sourceRoot = await realpath(sourceInput);
  if (!sourceRoot.startsWith('/private/tmp/') || (await lstat(sourceInput)).isSymbolicLink())
    throw new Error('select an isolated temporary source copy; Downloads and original checkouts are forbidden');
  await mkdir(evidenceRoot, { mode: 0o700 });
  await mkdir(profile, { mode: 0o700 });
  let runtime: z.infer<typeof SetupSnapshotSchema> | undefined;
  if (target === 'packaged') {
    if (!runtimeFile || !path.isAbsolute(runtimeFile) || !/^[a-f0-9]{64}$/.test(runtimeSha ?? ''))
      throw new Error('packaged acceptance additionally requires a verified runtime description and digest');
    const runtimeBytes = await readFile(runtimeFile);
    expect(sha256(runtimeBytes), 'runtime description must match the independently verified receipt').toBe(runtimeSha);
    runtime = SetupSnapshotSchema.parse(JSON.parse(runtimeBytes.toString('utf8')));
    expect(runtime).toMatchObject({
      stage: 'ready',
      busy: false,
      error: null,
      restartRequired: false,
      pendingLogin: null,
      config: { sbxBinary: binary, sandbox, localRoot: null, ssh: null },
    });
    // Prevent helpers.ts from synthesizing ready; never copy profile/Cookies/credentials or alter provider flags.
    await writeFile(path.join(profile, 'runtime.json'), runtimeBytes, { flag: 'wx', mode: 0o600 });
  }
  const sourceBefore = await selectedSourceDigest(sourceRoot);
  const evidence: Record<string, unknown> = {
    scope: 'real-electron-main-service-sbx-mota-manual-editor',
    target,
    sandbox,
    sourceRoot,
    expectedSha,
    runtimeDescriptionSha256: target === 'packaged' ? runtimeSha : null,
    runtimeConfiguration:
      target === 'packaged'
        ? 'verified runtime description copied unchanged'
        : 'explicit build-only sbx environment; no ready record synthesized',
    startedAt: new Date().toISOString(),
    result: 'not_run',
    picker: 'native dialog response automated; real Main collector, service, guest, Browser and editor are not mocked',
    sourceAuditScope: 'admitted noncredential Mota files only; Downloads original is not read or written',
    sourceBefore,
    notCovered: ['model/AI task', 'D run diff for manual editor', 'source export', 'physical microphone', 'Azure', 'other sandboxes'],
  };
  const failures: string[] = [];
  const milestone = (phase: 'preview' | 'imported' | 'edited' | 'potion' | 'stopped' | 'restarted') => {
    const at = new Date().toISOString();
    evidence['lastMilestone'] = { phase, at };
    console.info(`[mota-live] ${phase} ${at}`);
  };
  const auditGuest = async (projectId: string, expected: ProcessIdentity[] = [], guestPort?: number | null) => {
    if (!/^[a-f0-9-]{36}$/.test(projectId)) throw new Error('invalid owned project identity');
    // Reads only this imported project's two fixed save targets and process identity; no arbitrary paths or credentials.
    const program = `import os,sys,json,stat,hashlib,base64
root='/home/agent/workspace/.wsl-apps/'+sys.argv[1]
if os.path.realpath(root)!=root or not stat.S_ISDIR(os.lstat(root).st_mode): raise RuntimeError('invalid_owned_root')
def read_target(relative,optional=False):
 filename=root+'/'+relative
 if os.path.realpath(filename)!=filename: raise RuntimeError('linked_target')
 try: original=os.lstat(filename)
 except FileNotFoundError:
  if optional: return None
  raise
 if not stat.S_ISREG(original.st_mode) or original.st_nlink!=1 or original.st_size>262144: raise RuntimeError('invalid_target')
 fd=os.open(filename,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  info=os.fstat(fd)
  if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>262144: raise RuntimeError('invalid_target')
  if (original.st_dev,original.st_ino)!=(info.st_dev,info.st_ino): raise RuntimeError('changed_target')
  with os.fdopen(fd,'rb',closefd=False) as stream: content=stream.read(262145)
  if len(content)>262144: raise RuntimeError('oversize_target')
  return {'sha256':hashlib.sha256(content).hexdigest(),'base64':base64.b64encode(content).decode(),'mode':stat.S_IMODE(info.st_mode)}
 finally: os.close(fd)
floor=read_target('project/floors/MT1.js'); config=read_target('_server/config.json',True)
processes=[]; expected_remaining=[]; expected=json.loads(sys.argv[2]); port=json.loads(sys.argv[3]); sockets=set()
if port is not None:
 if not isinstance(port,int) or not 1<=port<=65535: raise RuntimeError('invalid_owned_port')
 for table in ['/proc/net/tcp','/proc/net/tcp6']:
  try:
   with open(table) as stream:
    for line in stream.readlines()[1:]:
     fields=line.split()
     if fields[3]=='0A' and int(fields[1].split(':')[-1],16)==port: sockets.add('socket:['+fields[9]+']')
  except FileNotFoundError: pass
for item in os.listdir('/proc'):
 if not item.isdigit(): continue
 try:
  text=open('/proc/'+item+'/stat').read(); tail=text[text.rfind(')')+2:].split()
  identity={'pid':int(item),'startTime':tail[19]}
  if identity in expected: expected_remaining.append(identity)
  if sockets:
   for fd_name in os.listdir('/proc/'+item+'/fd'):
    try: owned=os.readlink('/proc/'+item+'/fd/'+fd_name) in sockets
    except (FileNotFoundError,ProcessLookupError,PermissionError): continue
    if owned: processes.append(identity); break
 except (FileNotFoundError,ProcessLookupError,PermissionError): pass
print(json.dumps(dict(floor,config=config,processes=processes,expectedRemaining=expected_remaining)))`;
    const result = await exec(
      binary,
      ['exec', sandbox, 'python3', '-c', program, projectId, JSON.stringify(expected), JSON.stringify(guestPort ?? null)],
      { timeout: 30_000, maxBuffer: 2_500_000 },
    );
    const audit = GuestAudit.parse(JSON.parse(result.stdout));
    expect(sha256(Buffer.from(audit.base64, 'base64'))).toBe(audit.sha256);
    if (audit.config) expect(sha256(Buffer.from(audit.config.base64, 'base64'))).toBe(audit.config.sha256);
    return audit;
  };
  let auditKeeper: ChildProcessWithoutNullStreams | undefined;
  let auditKeeperExit: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string }> | undefined;
  const startAuditKeeper = async () => {
    // Keep this guest session alive across App stop/restart so VM auto-stop cannot hide a leaked server or reassign baseline ports.
    const keeper = spawn(
      binary,
      ['exec', '-i', sandbox, 'python3', '-u', '-c', "import sys; print('MOTA_AUDIT_ACTIVE',flush=True);sys.stdin.buffer.read()"],
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 660_000 },
    );
    auditKeeper = keeper;
    evidence['auditKeeper'] = {
      pid: keeper.pid,
      startedAt: new Date().toISOString(),
      purpose: 'owned read-only stdin keeper preserves VM lifetime and existing bindings through final port audit; owns no App',
      timeoutMs: 660_000,
    };
    auditKeeperExit = new Promise((resolve) => {
      keeper.once('close', (code, signal) => resolve({ code, signal }));
      keeper.once('error', (error) => resolve({ code: null, signal: null, error: String(error) }));
    });
    keeper.stderr.resume();
    keeper.stdin.on('error', (error) => {
      evidence['auditKeeperInputError'] = String(error);
    });
    await bounded(
      new Promise<void>((resolve, reject) => {
        let output = '';
        keeper.stdout.on('data', (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-1024);
          if (output.includes('MOTA_AUDIT_ACTIVE')) resolve();
        });
        keeper.once('error', reject);
        keeper.once('close', () => reject(new Error('port audit keeper exited before ready')));
      }),
      20_000,
      'port audit keeper did not become ready',
    );
  };
  const ports = async () => {
    if (!auditKeeper || auditKeeper.exitCode !== null || auditKeeper.signalCode !== null)
      throw new Error('continuous owned audit keeper exited before port verification');
    return orderedPorts(Ports.parse(JSON.parse((await exec(binary, ['ports', sandbox, '--json'], { timeout: 15_000 })).stdout)));
  };
  let app: ElectronApplication | undefined;
  let page: Page | undefined;
  let electronProcess: ReturnType<ElectronApplication['process']> | undefined;
  let electronExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let baselinePorts: z.infer<typeof Ports> | undefined;
  let projectId: string | undefined;
  let registered: ProcessIdentity[] = [];
  const ownedBinding = async (origin: string, guestPort: number | null | undefined) => {
    if (!baselinePorts) throw new Error('port baseline unavailable');
    const url = new URL(origin);
    expect(url.protocol).toBe('http:');
    expect(url.hostname).toBe('127.0.0.1');
    if (!guestPort) throw new Error('running App guest port unavailable');
    expect(guestPort).toBeGreaterThan(0);
    const binding = { host_ip: url.hostname, host_port: Number(url.port), sandbox_port: guestPort, protocol: 'tcp4' };
    expect(binding.host_port).toBeGreaterThan(0);
    expect(
      baselinePorts.some((port) => port.host_port === binding.host_port),
      'new host port must not replace a baseline binding',
    ).toBe(false);
    expect(
      baselinePorts.some((port) => port.sandbox_port === binding.sandbox_port),
      'new guest port must not reuse a baseline binding',
    ).toBe(false);
    const current = await ports();
    expect(current, 'only this App binding may be added to the preserved baseline').toEqual(orderedPorts([...baselinePorts, binding]));
    return { binding, ports: current };
  };
  const state = async () => {
    if (!page) throw new Error('workbench not launched');
    const current = (await workspaceSnapshot(page)).workspaces.find((item) => item.workspaceId === workspaceId);
    if (!current) throw new Error('owned workspace unavailable');
    return current;
  };
  const waitState = async (expected: 'running' | 'stopped') => {
    await expect
      .poll(
        async () => {
          const current = (await state()).managedApp;
          if (current?.state === 'failed') throw new Error('managed App failed: ' + current.error);
          return current?.state;
        },
        { timeout: 180_000 },
      )
      .toBe(expected);
  };
  const resource = async (entry: AppPage) => {
    const matches = (await state()).resources.filter(
      (item) => item.appProjectId === projectId && 'appPage' in item && item.appPage === entry,
    );
    expect(matches, entry + ' must have one stable resource').toHaveLength(1);
    const current = matches[0];
    if (!current || (entry === 'game' && !current.preview)) throw new Error(entry + ' native resource unavailable');
    return current;
  };
  const openEntry = async (entry: AppPage) => {
    if (!app || !page) throw new Error('workbench not launched');
    await page.getByRole('button', { name: '管理 App', exact: true }).click();
    await page.getByRole('button', { name: entry === 'game' ? '游戏页面' : '地图编辑器', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '空间 App' })).not.toBeVisible();
    const current = await resource(entry);
    const tab = (await state()).tabs.find((item) => item.targetRef.resourceId === current.resourceId);
    if (!tab) throw new Error(entry + ' tab unavailable');
    await expect
      .poll(async () => {
        const currentState = await state();
        return activeTab(currentState.layout, currentState.activePaneId);
      })
      .toBe(tab.tabId);
    const view = app.windows().find((candidate) => candidate.url() === current.url);
    if (!view) throw new Error(entry + ' native page unavailable');
    const geometry = await app.evaluate(({ BrowserWindow }, url) => {
      const native = BrowserWindow.getAllWindows()[0]?.contentView.children.find(
        (candidate) => (candidate as Electron.WebContentsView).webContents?.getURL() === url,
      ) as Electron.WebContentsView | undefined;
      return native ? { visible: native.getVisible(), bounds: native.getBounds(), webContentsId: native.webContents.id } : null;
    }, current.url);
    expect(geometry?.visible).toBe(true);
    expect(geometry?.bounds.width).toBeGreaterThan(100);
    expect(geometry?.bounds.height).toBeGreaterThan(100);
    return { view, resource: current, tab, geometry };
  };
  const readGame = (game: Page) =>
    game.evaluate(() => {
      const core = (window as Window & { core?: MotaCore }).core;
      if (!core?.status.hero) return null;
      return {
        floorId: core.status.floorId,
        x: core.status.hero.loc.x,
        y: core.status.hero.loc.y,
        hp: core.status.hero.hp,
        tile: core.getBlockNumber(6, 10, 'MT1'),
        route: [...core.status.route],
        lockControl: core.status.lockControl,
      };
    });
  try {
    const inspected = JSON.parse((await exec(binary, ['inspect', '--json', sandbox], { timeout: 20_000 })).stdout) as { state?: unknown };
    expect(['running', 'stopped']).toContain(inspected.state);
    evidence['sandboxInitialState'] = inspected.state;
    await startAuditKeeper();
    baselinePorts = await ports();
    evidence['baselinePorts'] = baselinePorts;
    // Pre-existing bindings belong to other work and remain untouched throughout this run.
    ({ app, page } = await launchApp({ live: true, userData: profile }));
    electronProcess = app.process();
    electronExit = new Promise((resolve) => electronProcess!.once('exit', (code, signal) => resolve({ code, signal })));
    if (runtime) {
      const launchedSetup = await page.evaluate(() => window.studio.setup.status());
      expect(launchedSetup).toMatchObject({
        stage: 'ready',
        modelCredentialsConfigured: runtime.modelCredentialsConfigured,
        modelConnectionVerified: false,
        config: { sbxBinary: binary, sandbox, localRoot: null, ssh: null },
      });
    }
    evidence['electronVersions'] = await app.evaluate(() => process.versions);
    if (target === 'build')
      evidence['productBundles'] = Object.fromEntries(
        await Promise.all(
          ['apps/desktop/out/main/index.js', 'apps/desktop/out/preload/index.js', 'apps/service/out/index.cjs'].map(async (file) => [
            file,
            sha256(await readFile(path.resolve(file))),
          ]),
        ),
      );
    await workshopNavigate(page, '空间');
    await page.getByRole('button', { name: '新建 App', exact: true }).click();
    await chooseImportSource(app, sourceRoot);
    await page.getByRole('button', { name: '导入已有工程', exact: true }).click();
    await expect.poll(async () => (await state()).appImport?.phase, { timeout: 30_000 }).toBe('ready');
    expect((await state()).appImport?.preview).toMatchObject({ profile: 'mota-web', sourceSha256: expectedSha });
    expect((await state()).managedApp).toBeFalsy();
    expect(await ports()).toEqual(baselinePorts);
    await page.screenshot({ path: path.join(evidenceRoot, '01-import-preview.png') });
    evidence['staticPreview'] = (await state()).appImport;
    milestone('preview');
    await page.getByRole('button', { name: '确认导入并启动', exact: true }).click();
    await waitState('running');
    await expect(page.getByRole('dialog', { name: '空间 App' })).not.toBeVisible();
    const first = (await state()).managedApp;
    if (!first?.url || !first.appInstanceId) throw new Error('running app identity missing');
    projectId = first.projectId;
    expect(first.profile).toMatchObject({ projectKind: 'mota-web', profileVersion: 1 });
    expect(first.sourceSha256).toBe(expectedSha);
    expect(first.guestCwd).toBe('/home/agent/workspace/.wsl-apps/' + projectId);
    evidence['first'] = first;
    evidence['firstBinding'] = await ownedBinding(first.url, first.guestPort);
    milestone('imported');
    const automaticGame = await resource('game');
    const automaticTab = (await state()).tabs.find((item) => item.targetRef.resourceId === automaticGame.resourceId);
    const importedState = await state();
    expect(automaticTab?.tabId).toBeTruthy();
    expect(activeTab(importedState.layout, importedState.activePaneId)).toBe(automaticTab?.tabId);
    evidence['automaticGameResourceId'] = automaticGame.resourceId;
    const game = await openEntry('game');
    expect(game.view.url()).toBe(first.url + '/index.html');
    const editor = await openEntry('editor');
    expect(editor.view.url()).toBe('wsl-editor://mota/index.html');
    expect(editor.resource.resourceId).not.toBe(game.resource.resourceId);
    expect(editor.geometry?.webContentsId).not.toBe(game.geometry?.webContentsId);
    const partitions = await app.evaluate(
      ({ webContents }, ids) => {
        const gameSession = webContents.fromId(ids[0]!)!.session;
        const editorSession = webContents.fromId(ids[1]!)!.session;
        return { distinct: gameSession !== editorSession, editorStorage: editorSession.getStoragePath() };
      },
      [game.geometry?.webContentsId, editor.geometry?.webContentsId],
    );
    expect(partitions).toEqual({ distinct: true, editorStorage: null });
    expect((await state()).resources.filter((item) => item.appProjectId === projectId)).toHaveLength(2);
    for (const entry of [game])
      expect(await entry.view.evaluate(async () => (await fetch('/api/health')).json())).toEqual({
        ok: true,
        templateId: 'mota-web',
        templateVersion: '1.0.0',
        identity: { workspaceId, projectId, environmentId: 'sandbox', appInstanceId: first.appInstanceId },
      });
    expect(
      await editor.view.evaluate(() => ({
        node: typeof process,
        studio: typeof window.studio,
        editor: typeof Reflect.get(window, 'motaEditor'),
      })),
    ).toEqual({
      node: 'undefined',
      studio: 'undefined',
      editor: 'object',
    });
    await editor.view.getByRole('button', { name: '读取当前版本', exact: true }).click();
    await expect(editor.view.getByRole('status')).toHaveText('已读取当前版本。');
    await editor.view.getByLabel(/^文件内容/).click();
    await editor.view.keyboard.press('ControlOrMeta+A');
    await editor.view.keyboard.insertText('unsaved navigation sentinel');
    await openEntry('game');
    const reopened = await openEntry('editor');
    expect(reopened.resource.resourceId).toBe(editor.resource.resourceId);
    expect(reopened.geometry?.webContentsId).toBe(editor.geometry?.webContentsId);
    await expect(reopened.view.getByLabel(/^文件内容/)).toHaveValue('unsaved navigation sentinel');
    await expect
      .poll(() =>
        reopened.view.evaluate(async () => {
          const bridge = (window as unknown as { motaEditor: MotaEditorBridge }).motaEditor;
          return (await bridge.status({ sessionIndex: null, requestId: crypto.randomUUID() })).state;
        }),
      )
      .toBe('active');
    // Read through the real narrow bridge while this document is authorized.
    // The renderer receives an index, never the private guest session ID/nonce.
    const oldBaseline = await reopened.view.evaluate<MotaEditorReadResult, MotaEditorReadInput['file']>(async (file) => {
      const bridge = (window as unknown as { motaEditor: MotaEditorBridge }).motaEditor;
      const current = await bridge.status({ sessionIndex: null, requestId: crypto.randomUUID() });
      if (current.state !== 'active' || current.sessionIndex === null) throw new Error('live editor admission is not active');
      return bridge.read({ sessionIndex: current.sessionIndex, requestId: crypto.randomUUID(), file });
    }, floorPath);
    if (oldBaseline.content === null) throw new Error('live editor floor baseline is missing');
    const beforeRevocation = await auditGuest(projectId, [], first.guestPort);
    expect(beforeRevocation.processes.length).toBeGreaterThan(0);
    registered = beforeRevocation.processes;
    expect(oldBaseline.contentHash).toBe(beforeRevocation.sha256);
    expect(Buffer.from(oldBaseline.content).equals(Buffer.from(beforeRevocation.base64, 'base64'))).toBe(true);
    const deniedContent = oldBaseline.content + '\n';
    expect(Buffer.byteLength(deniedContent)).toBeLessThanOrEqual(262144);
    expect(sha256(deniedContent)).not.toBe(beforeRevocation.sha256);
    expect(parseFloor(Buffer.from(deniedContent))).toEqual(parseFloor(Buffer.from(oldBaseline.content)));
    await page.getByRole('button', { name: editor.tab.title + '操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '关闭标签（保留后台执行）', exact: true }).click();
    expect((await state()).tabs.some((item) => item.tabId === editor.tab.tabId)).toBe(false);
    expect((await state()).managedApp).toMatchObject({ state: 'running', appInstanceId: first.appInstanceId });
    const oldWebContentsId = reopened.geometry?.webContentsId;
    if (oldWebContentsId === undefined) throw new Error('live editor native identity is missing');
    expect(
      await app.evaluate(({ webContents }, id) => {
        const contents = webContents.fromId(id);
        return { alive: !!contents && !contents.isDestroyed(), url: contents?.getURL() ?? null };
      }, oldWebContentsId),
    ).toEqual({ alive: true, url: 'wsl-editor://mota/index.html' });
    expect(await reopened.view.evaluate(() => typeof Reflect.get(window, 'motaEditor'))).toBe('object');
    await expect
      .poll(() =>
        reopened.view.evaluate(async (sessionIndex) => {
          const bridge = (window as unknown as { motaEditor: MotaEditorBridge }).motaEditor;
          return (await bridge.status({ sessionIndex, requestId: crypto.randomUUID() })).state;
        }, oldBaseline.sessionIndex),
      )
      .toBe('revoked');
    const deniedRequest: MotaEditorSaveInput = {
      sessionIndex: oldBaseline.sessionIndex,
      requestId: crypto.randomUUID(),
      file: floorPath,
      expectedHash: oldBaseline.contentHash,
      content: deniedContent,
    };
    // Await the actual save IPC. Closed targets, absent bridges, busy/conflict
    // errors and transport failures must not count as Main authorization denial.
    const denial = await deniedEditorSave(reopened.view, deniedRequest);
    const afterRevocation = await auditGuest(projectId, [], first.guestPort);
    evidence['revokedEditorSave'] = {
      trigger: 'closed editor tab through product UI',
      liveDocumentAndBridgeConfirmed: true,
      oldSessionState: 'revoked',
      request: 'real motaEditor.save with a previously read session and valid changed MT1 text',
      rejection: denial.rejection,
      file: floorPath,
      beforeSha256: beforeRevocation.sha256,
      afterSha256: afterRevocation.sha256,
      bytesUnchanged: afterRevocation.base64 === beforeRevocation.base64,
      modeUnchanged: afterRevocation.mode === beforeRevocation.mode,
      configUnchanged: JSON.stringify(afterRevocation.config) === JSON.stringify(beforeRevocation.config),
    };
    expect(targetSnapshot(afterRevocation)).toEqual(targetSnapshot(beforeRevocation));
    expect((await state()).managedApp).toMatchObject({ state: 'running', appInstanceId: first.appInstanceId });
    const afterClose = await openEntry('editor');
    expect(afterClose.resource.resourceId).toBe(editor.resource.resourceId);
    expect(afterClose.geometry?.webContentsId).toBe(editor.geometry?.webContentsId);
    await expect(afterClose.view.getByLabel(/^文件内容/)).toHaveValue('unsaved navigation sentinel');
    evidence['dualResources'] = {
      game: game.resource,
      editor: afterClose.resource,
      sameAppInstanceId: first.appInstanceId,
      closeViewDidNotStop: true,
    };
    expect(first.guestPort, 'running server must publish its real guest port').toBeGreaterThan(0);
    const before = await auditGuest(projectId, [], first.guestPort);
    expect(before.processes.length, 'server PID/starttime must own the listening socket for the recorded guest port').toBeGreaterThan(0);
    registered = before.processes;
    const beforeBytes = Buffer.from(before.base64, 'base64');
    const beforeFloor = parseFloor(beforeBytes);
    expect(beforeFloor.map[10]?.[6]).toBe(0);
    const editedMap = beforeFloor.map.map((row) => [...row]);
    const row = editedMap[10];
    if (!row || row.length !== 13) throw new Error('fixed acceptance map geometry changed');
    row[6] = 31;
    await editor.view.getByRole('button', { name: '读取当前版本', exact: true }).click();
    await expect(editor.view.getByRole('status')).toHaveText('已读取当前版本。');
    const savedText = 'main.floors.MT1 = ' + JSON.stringify({ ...beforeFloor, map: editedMap }) + ';\n';
    await editor.view.getByLabel(/^文件内容/).click();
    await editor.view.keyboard.press('ControlOrMeta+A');
    await editor.view.keyboard.insertText(savedText);
    await editor.view.getByRole('button', { name: '保存到副本', exact: true }).click();
    await expect(editor.view.getByRole('status')).toHaveText('已保存到副本。可刷新游戏查看。');
    const after = await auditGuest(projectId, [], first.guestPort);
    const afterBytes = Buffer.from(after.base64, 'base64');
    expect(after.sha256).not.toBe(before.sha256);
    expect(parseFloor(afterBytes)).toEqual({ ...beforeFloor, map: editedMap });
    expect(after.config).toEqual(before.config);
    const editorStatus = await editor.view.evaluate(() =>
      (window as unknown as { motaEditor: MotaEditorBridge }).motaEditor.status({ sessionIndex: null, requestId: crypto.randomUUID() }),
    );
    const manualCommit = editorStatus.operations.find((entry) => entry.operation.status === 'committed');
    expect(manualCommit?.operation.receipt).toMatchObject({
      file: floorPath,
      expectedHash: before.sha256,
      afterHash: after.sha256,
      contentHash: after.sha256,
      contentLength: afterBytes.length,
    });
    expect(
      Buffer.from(
        await game.view.evaluate(async () => await (await fetch('/project/floors/MT1.js', { cache: 'no-store' })).text()),
        'utf8',
      ).equals(afterBytes),
    ).toBe(true);
    await writeFile(path.join(evidenceRoot, 'MT1-before.js'), beforeBytes, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(evidenceRoot, 'MT1-after.js'), afterBytes, { flag: 'wx', mode: 0o600 });
    evidence['manualEditorSave'] = {
      path: floorPath,
      beforeSha256: before.sha256,
      afterSha256: after.sha256,
      beforeBytes: beforeBytes.length,
      afterBytes: afterBytes.length,
      cell: { x: 6, y: 10, before: 0, after: 31 },
      operation: manualCommit,
      diffEvidence: 'independent guest bytes and hashes; D run diff does not cover manual editor',
    };
    // Use the real initial configuration state. Never delete an imported config to manufacture an absent-file case.
    const originalConfig = after.config
      ? z.record(z.string(), z.unknown()).parse(JSON.parse(Buffer.from(after.config.base64, 'base64').toString('utf8')))
      : {};
    const configSaves = [];
    let configBaseline = after;
    await editor.view.getByLabel('文件', { exact: true }).selectOption(configPath);
    for (const revision of [1, 2]) {
      await editor.view.getByRole('button', { name: '读取当前版本', exact: true }).click();
      await expect(editor.view.getByRole('status')).toHaveText('已读取当前版本。');
      await expect(editor.view.getByLabel(/^文件内容/)).toHaveValue(
        configBaseline.config ? Buffer.from(configBaseline.config.base64, 'base64').toString('utf8') : '',
      );
      const configText = JSON.stringify({ ...originalConfig, __wslR6Acceptance: { projectId, revision } }) + '\n';
      expect(Buffer.byteLength(configText)).toBeLessThanOrEqual(262144);
      await editor.view.getByLabel(/^文件内容/).click();
      await editor.view.keyboard.press('ControlOrMeta+A');
      await editor.view.keyboard.insertText(configText);
      await editor.view.getByRole('button', { name: '保存到副本', exact: true }).click();
      await expect(editor.view.getByRole('status')).toHaveText('已保存到副本。可刷新游戏查看。');
      const saved = await auditGuest(projectId, [], first.guestPort);
      expect(saved.config).not.toBeNull();
      expect(saved.config?.base64).toBe(Buffer.from(configText).toString('base64'));
      expect(saved.config?.sha256).toBe(sha256(configText));
      expect(targetSnapshot(saved).floor).toEqual(targetSnapshot(after).floor);
      const projection = await editor.view.evaluate(() =>
        (window as unknown as { motaEditor: MotaEditorBridge }).motaEditor.status({ sessionIndex: null, requestId: crypto.randomUUID() }),
      );
      const operation = projection.operations.find(
        (entry) => entry.operation.receipt?.file === configPath && entry.operation.receipt.afterHash === saved.config?.sha256,
      );
      expect(operation?.operation).toMatchObject({
        status: 'committed',
        receipt: {
          file: configPath,
          expectedHash: configBaseline.config?.sha256 ?? null,
          contentHash: sha256(configText),
          afterHash: sha256(configText),
          contentLength: Buffer.byteLength(configText),
          durabilityError: null,
        },
      });
      expect(operation?.sessionIndex).toBe(projection.sessionIndex);
      configSaves.push({ revision, before: auditSummary(configBaseline).config, after: auditSummary(saved).config, operation });
      configBaseline = saved;
    }
    expect(new Set(configSaves.map((save) => save.operation?.operation.requestId)).size).toBe(2);
    evidence['manualConfigSaves'] = { initialPresence: after.config === null ? 'absent' : 'present', saves: configSaves };
    // Preserve the original MT1 draft and selection contract used by the stop/restart assertions below.
    await editor.view.getByLabel('文件', { exact: true }).selectOption(floorPath);
    await expect(editor.view.getByLabel(/^文件内容/)).toHaveValue(savedText);
    milestone('edited');
    await editor.view.screenshot({ path: path.join(evidenceRoot, '02-editor-saved.png') });
    const playable = (await openEntry('game')).view;
    await playable.reload();
    await expect(playable.locator('#playGame')).toBeVisible();
    expect(await playable.evaluate(() => (window as Window & { core?: MotaCore }).core?.flags.startUsingCanvas)).toBe(false);
    await playable.locator('#playGame').click(); // Explicit new game; never load a prior save or assign game state.
    await expect
      .poll(() => readGame(playable), { timeout: 30_000 })
      .toMatchObject({ floorId: 'MT1', x: 6, y: 11, hp: 1000, tile: 31, route: [], lockControl: false });
    evidence['freshGame'] = { action: 'clicked #playGame after reload in a new private profile', state: await readGame(playable) };
    await playable.screenshot({ path: path.join(evidenceRoot, '03-fresh-game.png') });
    await playable.keyboard.press('ArrowUp');
    await expect.poll(() => readGame(playable)).toMatchObject({ x: 6, y: 10, hp: 1050, tile: null, route: ['up'], lockControl: false });
    evidence['firstPotion'] = await readGame(playable);
    await playable.screenshot({ path: path.join(evidenceRoot, '04-potion-consumed.png') });
    await playable.keyboard.press('ArrowDown');
    await expect.poll(() => readGame(playable)).toMatchObject({ x: 6, y: 11, hp: 1050, tile: null, lockControl: false });
    await playable.keyboard.press('ArrowUp');
    await expect
      .poll(() => readGame(playable))
      .toMatchObject({ x: 6, y: 10, hp: 1050, tile: null, route: ['up', 'down', 'up'], lockControl: false });
    evidence['noSecondPotion'] = await readGame(playable);
    milestone('potion');
    const beforeAttacks = await auditGuest(projectId, [], first.guestPort);
    expect(targetSnapshot(beforeAttacks)).toEqual(targetSnapshot(configBaseline));
    const attacks = [];
    for (const entry of ['game', 'imported-editor'] as const) {
      if (entry === 'imported-editor') {
        await playable.goto(first.url + '/editor.html', { waitUntil: 'domcontentloaded' });
        expect(playable.url()).toBe(first.url + '/editor.html');
      }
      expect(await playable.evaluate(() => ({ editor: typeof Reflect.get(window, 'motaEditor'), studio: typeof window.studio }))).toEqual({
        editor: 'undefined',
        studio: 'undefined',
      });
      const attempt = await untrustedSaveAttempts(playable);
      expect(attempt).toEqual({
        oldStatus: 200,
        nonceDisclosed: false,
        editor: 'undefined',
        studio: 'undefined',
        statuses: [
          { file: floorPath, status: 403, body: 'error: http_write_disabled' },
          { file: configPath, status: 403, body: 'error: http_write_disabled' },
        ],
      });
      const afterAttack = await auditGuest(projectId, [], first.guestPort);
      expect(targetSnapshot(afterAttack)).toEqual(targetSnapshot(beforeAttacks));
      attacks.push({ entry, ...attempt, unchangedTargets: [floorPath, configPath], audit: auditSummary(afterAttack) });
    }
    evidence['untrustedSaveAttempts'] = attacks;
    // Restore the game resource's real route before the existing stop/rebind checks.
    await playable.goto(first.url + '/index.html', { waitUntil: 'domcontentloaded' });
    expect(playable.url()).toBe(first.url + '/index.html');
    const beforeStopEditor = await openEntry('editor');
    expect(beforeStopEditor.geometry?.webContentsId).toBe(editor.geometry?.webContentsId);
    await expect
      .poll(() =>
        beforeStopEditor.view.evaluate(async () => {
          const bridge = (window as unknown as { motaEditor: MotaEditorBridge }).motaEditor;
          return (await bridge.status({ sessionIndex: null, requestId: crypto.randomUUID() })).state;
        }),
      )
      .toBe('active');
    await expect(beforeStopEditor.view.getByLabel('文件', { exact: true })).toHaveValue(floorPath);
    await beforeStopEditor.view.getByRole('button', { name: '读取当前版本', exact: true }).click();
    await expect(beforeStopEditor.view.getByRole('status')).toHaveText('已读取当前版本。');
    await expect(beforeStopEditor.view.getByLabel(/^文件内容/)).toHaveValue(savedText);
    const saveTargets: MotaEditorReadInput['file'][] = [floorPath, configPath];
    const stopBaselines = await beforeStopEditor.view.evaluate(async (files: MotaEditorReadInput['file'][]) => {
      const bridge = (window as unknown as { motaEditor: MotaEditorBridge }).motaEditor;
      const current = await bridge.status({ sessionIndex: null, requestId: crypto.randomUUID() });
      if (current.state !== 'active' || current.sessionIndex === null) throw new Error('pre-stop editor admission is not active');
      const baselines = [];
      for (const file of files) {
        const baseline = await bridge.read({ file, sessionIndex: current.sessionIndex, requestId: crypto.randomUUID() });
        baselines.push({ file, baseline });
      }
      return baselines;
    }, saveTargets);
    expect(new Set(stopBaselines.map((item) => item.baseline.sessionIndex)).size).toBe(1);
    const stopRequests: MotaEditorSaveInput[] = stopBaselines.map(({ file, baseline }) => {
      if (baseline.content === null) throw new Error('saved target must exist before stop: ' + file);
      const expected = file === floorPath ? beforeAttacks : beforeAttacks.config;
      expect(expected).not.toBeNull();
      expect(baseline.contentHash).toBe(expected?.sha256);
      expect(Buffer.from(baseline.content).toString('base64')).toBe(expected?.base64);
      const content = baseline.content + '\n';
      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(262144);
      expect(sha256(content)).not.toBe(baseline.contentHash);
      if (file === floorPath) expect(parseFloor(Buffer.from(content))).toEqual(parseFloor(Buffer.from(baseline.content)));
      else expect(JSON.parse(content)).toEqual(JSON.parse(baseline.content));
      return { file, sessionIndex: baseline.sessionIndex, requestId: crypto.randomUUID(), expectedHash: baseline.contentHash, content };
    });
    await page.getByRole('button', { name: '管理 App', exact: true }).click();
    await expect(page.getByRole('button', { name: '导出源码', exact: true })).toBeHidden();
    await page.getByRole('button', { name: '停止应用', exact: true }).click();
    await waitState('stopped');
    expect((await state()).managedApp?.cleanupConfirmed).toBe(true);
    for (const item of (await state()).resources.filter((entry) => entry.appProjectId === projectId)) expect(item.instanceId).toBeNull();
    expect(await ports()).toEqual(baselinePorts);
    const stopped = await auditGuest(projectId, registered);
    expect(stopped).toMatchObject({ processes: [], expectedRemaining: [], sha256: after.sha256 });
    expect(targetSnapshot(stopped)).toEqual(targetSnapshot(beforeAttacks));
    const stoppedDenials = [];
    for (const request of stopRequests) stoppedDenials.push(await deniedEditorSave(beforeStopEditor.view, request));
    const afterStoppedDenials = await auditGuest(projectId, registered);
    expect(targetSnapshot(afterStoppedDenials)).toEqual(targetSnapshot(stopped));
    expect(afterStoppedDenials).toMatchObject({ processes: [], expectedRemaining: [] });
    await expect(fetch(first.url + '/api/health', { signal: AbortSignal.timeout(1500) })).rejects.toThrow();
    evidence['stopped'] = {
      state: (await state()).managedApp,
      audit: auditSummary(afterStoppedDenials),
      oldSessionDenials: stoppedDenials,
    };
    milestone('stopped');
    await page.getByRole('button', { name: '启动应用', exact: true }).click();
    await waitState('running');
    const second = (await state()).managedApp;
    if (!second?.url || !second.appInstanceId) throw new Error('restarted app identity missing');
    expect(second?.appInstanceId).not.toBe(first.appInstanceId);
    expect(second?.projectId).toBe(projectId);
    evidence['restartBinding'] = await ownedBinding(second.url, second.guestPort);
    const beforeRestartDenials = await auditGuest(projectId, [], second.guestPort);
    expect(beforeRestartDenials.processes.length).toBeGreaterThan(0);
    expect(targetSnapshot(beforeRestartDenials)).toEqual(targetSnapshot(stopped));
    registered = [...registered, ...beforeRestartDenials.processes];
    const restartedDenials = [];
    let restartedSessionIndex: number | null = null;
    await page.getByRole('dialog', { name: '空间 App' }).press('Escape');
    for (const entry of ['game', 'editor'] as const) {
      const rebound = await openEntry(entry);
      expect(rebound.resource.resourceId).toBe(entry === 'game' ? game.resource.resourceId : editor.resource.resourceId);
      if (entry === 'game') {
        expect(rebound.view.url()).toBe(second.url + '/index.html');
        expect(await rebound.view.evaluate(async () => (await fetch('/api/health')).json())).toMatchObject({
          identity: { projectId, appInstanceId: second?.appInstanceId },
        });
      } else {
        expect(rebound.view.url()).toBe('wsl-editor://mota/index.html');
        expect(rebound.geometry?.webContentsId).toBe(editor.geometry?.webContentsId);
        await expect(rebound.view.getByLabel('文件', { exact: true })).toHaveValue(floorPath);
        await expect(rebound.view.getByLabel(/^文件内容/)).toHaveValue(savedText);
        await expect(rebound.view.getByRole('button', { name: '保存到副本', exact: true })).toBeDisabled();
        await expect
          .poll(() =>
            rebound.view.evaluate(async () => {
              const bridge = (window as unknown as { motaEditor: MotaEditorBridge }).motaEditor;
              return (await bridge.status({ sessionIndex: null, requestId: crypto.randomUUID() })).state;
            }),
          )
          .toBe('active');
        const projection = await rebound.view.evaluate(() =>
          (window as unknown as { motaEditor: MotaEditorBridge }).motaEditor.status({ sessionIndex: null, requestId: crypto.randomUUID() }),
        );
        expect(projection.sessionIndex).not.toBeNull();
        restartedSessionIndex = projection.sessionIndex;
        for (const request of stopRequests) {
          expect(projection.sessionIndex).not.toBe(request.sessionIndex);
          restartedDenials.push(await deniedEditorSave(rebound.view, { ...request, requestId: crypto.randomUUID() }));
        }
        const afterRestartDenials = await auditGuest(projectId, [], second.guestPort);
        expect(targetSnapshot(afterRestartDenials)).toEqual(targetSnapshot(beforeRestartDenials));
        await expect(rebound.view.getByRole('button', { name: '保存到副本', exact: true })).toBeDisabled();
        await rebound.view.getByRole('button', { name: '读取当前版本', exact: true }).click();
        await expect(rebound.view.getByRole('status')).toHaveText('已读取当前版本。');
        await expect(rebound.view.getByLabel(/^文件内容/)).toHaveValue(savedText);
      }
    }
    expect(second?.guestPort).toBeGreaterThan(0);
    const restarted = await auditGuest(projectId, [], second?.guestPort);
    expect(restarted.processes.length).toBeGreaterThan(0);
    expect(restarted.sha256).toBe(after.sha256);
    expect(targetSnapshot(restarted)).toEqual(targetSnapshot(beforeAttacks));
    evidence['restarted'] = {
      app: second,
      audit: auditSummary(restarted),
      oldSessionDenials: restartedDenials,
      freshSessionIndex: restartedSessionIndex,
    };
    milestone('restarted');
    evidence['result'] = 'passed';
  } catch (error) {
    evidence['result'] = 'failed';
    failures.push(String(error));
    if (app && page && !page.isClosed()) {
      try {
        const current = (await bounded(state(), 5_000, 'failure state observation timed out')).managedApp;
        evidence['failureApp'] = current
          ? {
              state: current.state,
              projectId: current.projectId,
              appInstanceId: current.appInstanceId,
              guestPort: current.guestPort,
              cleanupConfirmed: current.cleanupConfirmed,
              error: current.error,
            }
          : null;
      } catch (observationError) {
        evidence['failureObservationError'] = String(observationError);
      }
      try {
        // This is the Page returned by this test's launchApp, never the desktop or another application.
        await page.screenshot({ path: path.join(evidenceRoot, 'failure-owned-app.png'), timeout: 5_000 });
        evidence['failureScreenshot'] = 'failure-owned-app.png';
      } catch (screenshotError) {
        evidence['failureScreenshotError'] = String(screenshotError);
      }
    }
  } finally {
    const cleanup: string[] = [];
    let electronSigtermSent = false;
    const failCleanup = (phase: string, error: unknown) => {
      const message = phase + ': ' + String(error);
      cleanup.push(message);
      failures.push(message);
      evidence['result'] = 'failed';
    };
    if (app && page && electronProcess?.exitCode === null && electronProcess.signalCode === null) {
      try {
        const current = (await bounded(state(), 5_000, 'owned state unavailable before cleanup')).managedApp;
        // This fresh profile's workspace had no app before our import; retain even a failed import's new identity for cleanup.
        if (!projectId) projectId = current?.projectId;
        if (current && current.projectId === projectId && !current.cleanupConfirmed) {
          const result = await bounded(
            page.evaluate(() =>
              window.studio.workbench.command({ type: 'stopApp', workspaceId: 'taskflow-demo', commandId: crypto.randomUUID() }),
            ),
            45_000,
            'owned stop did not settle',
          );
          expect(result.ok).toBe(true);
        }
        const finalApp = (await bounded(state(), 5_000, 'owned state unavailable after cleanup')).managedApp;
        evidence['finalApp'] = finalApp;
        if (projectId) expect(finalApp?.cleanupConfirmed).toBe(true);
      } catch (error) {
        failCleanup('stop', error);
      }
    }
    if (app) {
      try {
        await bounded(app.close(), 20_000, 'owned Electron close timed out');
      } catch (error) {
        failCleanup('close', error);
        // This process handle was created by this test. Never kill a guest or any pre-existing app.
        if (electronProcess?.exitCode === null && electronProcess.signalCode === null) {
          electronSigtermSent = electronProcess.kill('SIGTERM');
          evidence['electronSigtermSent'] = electronSigtermSent;
        }
      }
    }
    if (electronExit) {
      try {
        const result = await bounded(electronExit, 15_000, 'owned Electron exit unconfirmed');
        evidence['electronExit'] = result;
        expect(result).toEqual({ code: 0, signal: null });
      } catch (error) {
        failCleanup('exit', error);
        if (electronSigtermSent && electronProcess?.exitCode === null && electronProcess.signalCode === null) {
          try {
            // SIGTERM already had 15 seconds; this retained child handle belongs exclusively to this test.
            evidence['electronSigkillSent'] = electronProcess.kill('SIGKILL');
            evidence['electronForcedExit'] = await bounded(electronExit, 10_000, 'owned Electron exit unconfirmed after SIGKILL');
          } catch (forcedExitError) {
            failCleanup('forced-exit', forcedExitError);
          }
        }
      }
    }
    if (projectId) {
      try {
        const audit = await auditGuest(projectId, registered);
        evidence['finalGuestAudit'] = auditSummary(audit);
        expect(audit).toMatchObject({ processes: [], expectedRemaining: [] });
      } catch (error) {
        failCleanup('guest-audit', error);
      }
    }
    if (baselinePorts) {
      try {
        evidence['finalPorts'] = await ports();
        expect(evidence['finalPorts']).toEqual(baselinePorts);
      } catch (error) {
        failCleanup('ports', error);
      }
    }
    if (auditKeeper && auditKeeperExit) {
      try {
        const aliveUntilFinalAudit = auditKeeper.exitCode === null && auditKeeper.signalCode === null;
        auditKeeper.stdin.end();
        const result = await bounded(auditKeeperExit, 10_000, 'owned audit keeper did not exit after EOF');
        evidence['auditKeeperExit'] = { ...result, endedAt: new Date().toISOString(), aliveUntilFinalAudit };
        expect(aliveUntilFinalAudit, 'the same keeper must remain alive through final port verification').toBe(true);
        expect(result).toEqual({ code: 0, signal: null });
      } catch (error) {
        failCleanup('audit-keeper', error);
        // Only this test's CLI handle may be terminated; never stop the sandbox or a pre-existing session.
        if (auditKeeper.exitCode === null && auditKeeper.signalCode === null) auditKeeper.kill('SIGTERM');
        try {
          evidence['auditKeeperFallbackExit'] = await bounded(auditKeeperExit, 10_000, 'owned audit keeper exit remains unconfirmed');
        } catch (fallbackError) {
          failCleanup('audit-keeper-exit', fallbackError);
        }
      }
    }
    try {
      evidence['sourceAfter'] = await selectedSourceDigest(sourceRoot);
      expect(evidence['sourceAfter']).toBe(sourceBefore);
    } catch (error) {
      failCleanup('source-audit', error);
    }
    evidence['failures'] = failures;
    evidence['cleanupErrors'] = cleanup;
    evidence['endedAt'] = new Date().toISOString();
    await writeFile(path.join(evidenceRoot, 'result.json'), JSON.stringify(evidence, null, 2), { mode: 0o600, flag: 'wx' });
  }
  expect(failures).toEqual([]);
});
