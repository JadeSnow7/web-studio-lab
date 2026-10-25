import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { AppInfoSchema, ExecutionStatusSchema } from '@wsl/protocol';
import { registerIpc, type IpcDeps } from './ipc';
import { debugStatusEnabled, type DebugStatus } from './debug-status';
import type { TrustedRenderer } from './ipc-guard';

/*
 * OPS-1 S3 / S4：Main 经已有只读通道发布两项能力——检查器是否接入（execution:get-status）
 * 与是否显示未接入的演示入口（app:get-info，与诊断通道同一判定）。renderer 不读环境变量，也不从 `studio.debug` 推断。
 */

const handlers = vi.hoisted(() => new Map<string, (event: IpcMainInvokeEvent, request: unknown) => unknown>());
const electronApp = vi.hoisted(() => ({ getVersion: () => '0.0.0-test', isPackaged: false }));
vi.mock('electron', () => ({
  app: electronApp,
  dialog: {},
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, request: unknown) => unknown) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));
const FILE: TrustedRenderer = { kind: 'file', url: 'file:///renderer/index.html' };
const eventFrom = (url: string) => {
  const frame = { url };
  return { sender: { mainFrame: frame }, senderFrame: frame } as unknown as IpcMainInvokeEvent;
};
let event = eventFrom(FILE.url);
let command: ReturnType<typeof vi.fn>;

function register(debug?: DebugStatus, trusted: TrustedRenderer = FILE) {
  handlers.clear();
  command = vi.fn();
  event = eventFrom(trusted.kind === 'file' ? trusted.url : `${trusted.origin}/index.html`);
  registerIpc({
    window: { isDestroyed: () => false, webContents: event.sender },
    chat: {},
    workbench: { command },
    trusted,
    ...(debug ? { debug } : {}),
  } as unknown as IpcDeps);
}
const invoke = (channel: string, request?: unknown) => Promise.resolve(handlers.get(channel)!(event, request));
const debugStub = () => ({ snapshot: vi.fn(), onWorkbench: vi.fn(), onChat: vi.fn() }) as unknown as DebugStatus;

beforeEach(() => {
  electronApp.isPackaged = false;
  register();
});
// vitest 在 Node 中运行：补上 Electron 运行时才有的版本字段，app:get-info 的响应 schema 才能通过；结束后还原。
const versions = process.versions as Record<string, string | undefined>;
const originalVersions = { electron: versions['electron'], chrome: versions['chrome'] };
beforeAll(() => {
  versions['electron'] ??= '0.0.0-test';
  versions['chrome'] ??= '0.0.0-test';
});
afterAll(() => {
  for (const [key, value] of Object.entries(originalVersions)) {
    if (value === undefined) delete versions[key];
    else versions[key] = value;
  }
});

describe('检查器能力（O06b）', () => {
  it('execution:get-status 明确发布“未接入”及结构化原因 not_integrated', async () => {
    const status = ExecutionStatusSchema.parse(await invoke('execution:get-status'));
    expect(status.checker).toEqual({ connected: false, reason: 'not_integrated' });
  });

  it('能力 schema 严格：未接入必须带已知原因，已接入不带原因', () => {
    const base = { available: false, reason: null, harness: { name: 'Codex CLI', state: 'integrated', version: null, model: null } };
    expect(ExecutionStatusSchema.safeParse({ ...base, checker: { connected: false, reason: 'not_integrated' } }).success).toBe(true);
    expect(ExecutionStatusSchema.safeParse({ ...base, checker: { connected: true } }).success).toBe(true);
    expect(ExecutionStatusSchema.safeParse({ ...base }).success).toBe(false);
    expect(ExecutionStatusSchema.safeParse({ ...base, checker: { connected: false } }).success).toBe(false);
    expect(ExecutionStatusSchema.safeParse({ ...base, checker: { connected: false, reason: '尚未接入' } }).success).toBe(false);
    expect(ExecutionStatusSchema.safeParse({ ...base, checker: { connected: true, reason: 'not_integrated' } }).success).toBe(false);
  });

  it('workbench:command 边界拒绝 accepted_unchecked，不进入应用', () => {
    const review = { commandId: 'c', workspaceId: 'taskflow-demo', type: 'recordReview', runId: 'r', candidateId: 'cand' };
    expect(() => handlers.get('workbench:command')!(event, { ...review, decision: 'accepted_unchecked' })).toThrow();
    expect(command).not.toHaveBeenCalled();
  });
});

describe('未接入入口的启用开关（O07）', () => {
  const DEV_SERVER: TrustedRenderer = { kind: 'dev-server', origin: 'http://localhost:5173' };
  // 与装配处相同的判定（index.ts：debugStatusEnabled(rendererSource(), process.env)；打包版的 rendererSource 恒为 file）。
  it.each([
    ['开发服务器（未打包）', DEV_SERVER, {}, false, true],
    ['file + WSL_DEBUG_STATUS=1（未打包）', FILE, { WSL_DEBUG_STATUS: '1' }, false, true],
    ['file 正式（未打包，E2E build）', FILE, {}, false, false],
    ['打包正式', FILE, {}, true, false],
    ['打包 + WSL_DEBUG_STATUS=1', FILE, { WSL_DEBUG_STATUS: '1' }, true, true],
    ['打包 + WSL_DEBUG_STATUS=true（不是 1）', FILE, { WSL_DEBUG_STATUS: 'true' }, true, false],
  ] as const)('%s：diagnostics 与 debug:status 是否注册完全一致', async (_name, trusted, env, packaged, expected) => {
    electronApp.isPackaged = packaged;
    const enabled = debugStatusEnabled(trusted, env);
    expect(enabled).toBe(expected);
    register(enabled ? debugStub() : undefined, trusted);
    const info = AppInfoSchema.parse(await invoke('app:get-info'));
    expect(info.packaged).toBe(packaged);
    expect(info.diagnostics).toBe(expected);
    expect(handlers.has('debug:status')).toBe(info.diagnostics);
  });

  it('AppInfo 必须显式携带 diagnostics', () => {
    const info = { appVersion: '1', electron: '1', chrome: '1', node: '1', platform: 'darwin', arch: 'arm64', packaged: true };
    expect(AppInfoSchema.safeParse(info).success).toBe(false);
    expect(AppInfoSchema.safeParse({ ...info, diagnostics: false }).success).toBe(true);
  });
});
