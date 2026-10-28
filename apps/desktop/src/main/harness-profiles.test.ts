import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessAvailability, ProfileCheckResult } from '@wsl/protocol';
import { HarnessProfileService, HarnessProfileStore, type ProfileRuntime } from './harness-profiles';

let root: string;
let file: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wsl-profiles-'));
  file = path.join(root, 'harness-profiles.json');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const available = (harnessId: string, displayName: string, ok = true): HarnessAvailability => ({
  descriptor: {
    harnessId,
    displayName,
    adapter: harnessId === 'codex' ? 'native' : 'acp',
    version: '1.0.0',
    capabilities: {
      structuredEvents: true,
      mcp: true,
      resume: true,
      permissionRequests: false,
      clientFs: false,
      clientTerminal: false,
      readOnlyMode: false,
      images: false,
    },
    capabilitySource: 'declared',
  },
  available: ok,
  reason: ok ? null : '探测失败',
});
function runtime(
  results: Record<string, ProfileCheckResult> = {},
  harnesses = [available('codex', 'Codex CLI'), available('claude-code', 'Claude Code')],
) {
  return {
    harnesses: vi.fn(() => harnesses),
    checkProfile: vi.fn(async (harnessId: string, profileDir: { path: string } | null) => {
      const key = profileDir ? (profileDir.path.split('/').at(-1) ?? '') : `${harnessId}:default`;
      return results[key] ?? { cliVersion: '1.0.0', login: 'logged_in' as const, reason: null };
    }),
  } satisfies ProfileRuntime;
}

describe('HarnessProfileStore（W4a）', () => {
  it('首次使用时只有两个内置 Profile，默认选择 Codex 的 sbx 默认', async () => {
    const snapshot = await new HarnessProfileStore(file).load();
    expect(snapshot.profiles.map((profile) => [profile.profileId, profile.configDir, profile.builtin])).toEqual([
      ['codex:default', null, true],
      ['claude-code:default', null, true],
    ]);
    expect(snapshot.defaultSelection).toEqual({ harnessId: 'codex', profileId: 'codex:default' });
  });

  it('新建 Profile 由 Lab 生成配置目录，持久化后可重新读取', async () => {
    const store = new HarnessProfileStore(file);
    await store.load();
    const created = (await store.create('  工作账号 ')).profiles.at(-1)!;
    expect(created).toMatchObject({ harnessId: 'claude-code', label: '工作账号', builtin: false, check: null });
    expect(created.configDir).toEqual({ env: 'CLAUDE_CONFIG_DIR', path: `/home/agent/.wsl-profiles/claude-code/${created.profileId}` });
    await store.recordCheck(created.profileId, { cliVersion: '0.94.0', login: 'logged_out', reason: null });
    const reloaded = await new HarnessProfileStore(file).load();
    expect(reloaded.profiles.find((profile) => profile.profileId === created.profileId)?.check).toMatchObject({ login: 'logged_out' });
  });

  it('内置 Profile 不能删除；删除默认 Profile 后回到 Codex 内置 Profile', async () => {
    const store = new HarnessProfileStore(file);
    await store.load();
    await expect(store.remove('codex:default')).rejects.toThrow('内置 Profile 不能删除');
    const created = (await store.create('A')).profiles.at(-1)!;
    await store.setDefault({ harnessId: 'claude-code', profileId: created.profileId });
    const after = await store.remove(created.profileId);
    expect(after.defaultSelection).toEqual({ harnessId: 'codex', profileId: 'codex:default' });
    await expect(store.setDefault({ harnessId: 'codex', profileId: 'claude-code:default' })).rejects.toThrow('不属于所选 Harness');
  });

  it.each([
    ['较新的版本', JSON.stringify({ schemaVersion: 2, profiles: [] }), '较新'],
    ['无效内容', '{"schemaVersion":1,"profiles":"x"}', '无法读取'],
  ])('%s：报错并保留原文件，之后的读取与修改报告同一原因', async (_label, contents, message) => {
    await writeFile(file, contents);
    const store = new HarnessProfileStore(file);
    await expect(store.load()).rejects.toThrow(message);
    expect(() => store.get()).toThrow(message);
    await expect(store.create('A')).rejects.toThrow(message);
    expect(await readFile(file, 'utf8')).toBe(contents);
  });

  it('持久化文件只含 Profile 字段与解析后的自检结果', async () => {
    const store = new HarnessProfileStore(file);
    await store.load();
    await store.recordCheck('claude-code:default', { cliVersion: '0.94.0', login: 'logged_in', reason: null });
    const saved = JSON.parse(await readFile(file, 'utf8')) as { profiles: Record<string, unknown>[] };
    expect(Object.keys(saved.profiles[1]!).sort()).toEqual([
      'builtin',
      'check',
      'configDir',
      'createdAt',
      'environmentId',
      'harnessId',
      'label',
      'profileId',
    ]);
    expect(Object.keys(saved.profiles[1]!['check'] as object).sort()).toEqual(['checkedAt', 'cliVersion', 'login', 'reason']);
  });
});

describe('HarnessProfileService（W4a）', () => {
  async function service(rt = runtime()) {
    const store = new HarnessProfileStore(file);
    await store.load();
    return { store, profiles: new HarnessProfileService(store, rt), rt };
  }

  it('两个同 Harness 的 Profile 分别自检，结果互不影响；同一 Profile 的并发自检合并为一次', async () => {
    const { store, profiles, rt } = await service();
    const a = (await store.create('A')).profiles.at(-1)!;
    const b = (await store.create('B')).profiles.at(-1)!;
    vi.mocked(rt.checkProfile).mockImplementation(async (_harnessId, dir) =>
      dir?.path.endsWith(a.profileId)
        ? { cliVersion: '0.94.0', login: 'logged_in', reason: null }
        : { cliVersion: '0.94.0', login: 'logged_out', reason: null },
    );
    await Promise.all([profiles.check(a.profileId), profiles.check(a.profileId), profiles.check(b.profileId)]);
    expect(rt.checkProfile).toHaveBeenCalledTimes(2);
    expect(store.find(a.profileId)?.check?.login).toBe('logged_in');
    expect(store.find(b.profileId)?.check?.login).toBe('logged_out');
  });

  it('自检出错时记为无法判断，不当作已登录', async () => {
    const { store, profiles, rt } = await service();
    vi.mocked(rt.checkProfile).mockRejectedValue(new Error('sbx 不可用'));
    await profiles.check('claude-code:default');
    expect(store.find('claude-code:default')?.check).toMatchObject({ login: 'undetermined', reason: 'sbx 不可用' });
  });

  it('解析：空选择用全局默认；只拒绝已删除或不属于该 Harness 的 Profile；未报告的内置 Harness 版本记为 null', async () => {
    const rt = runtime({}, [available('codex', 'Codex CLI')]);
    const { profiles } = await service(rt);
    expect(profiles.resolve(null)).toEqual({
      ref: { harnessId: 'codex', displayName: 'Codex CLI', adapter: 'native', version: '1.0.0', profileId: 'codex:default' },
      turn: { harnessId: 'codex', profileId: 'codex:default', profileDir: null },
    });
    expect(profiles.resolve({ harnessId: 'claude-code', profileId: 'claude-code:default' }).ref).toEqual({
      harnessId: 'claude-code',
      displayName: 'Claude Code',
      adapter: 'acp',
      version: null,
      profileId: 'claude-code:default',
    });
    expect(() => profiles.resolve({ harnessId: 'claude-code', profileId: 'a1b2c3d4-0000-4000-8000-00000000000a' })).toThrow(
      /^conflict: 所选 Profile 已删除/,
    );
    expect(() => profiles.resolve({ harnessId: 'codex', profileId: 'claude-code:default' })).toThrow(/^conflict: /);
  });

  it('启动路径：Harness 不可用时以其原因失败；上次未登录时先重新自检，以最新结果判断', async () => {
    const rt = runtime({}, [available('codex', 'Codex CLI'), available('claude-code', 'Claude Code', false)]);
    const { store, profiles } = await service(rt);
    await expect(profiles.prepare(profiles.resolve({ harnessId: 'claude-code', profileId: 'claude-code:default' }).turn)).rejects.toThrow(
      'Claude Code 不可用：探测失败',
    );
    await store.recordCheck('codex:default', { cliVersion: null, login: 'logged_out', reason: null });
    // 用户随后登录：重新自检得到已登录，启动继续。
    await expect(profiles.prepare(profiles.resolve(null).turn)).resolves.toBeUndefined();
    expect(store.find('codex:default')?.check?.login).toBe('logged_in');
  });

  it('执行服务尚未报告任何 Harness 时不在启动路径判断，由发送给出原始原因', async () => {
    const rt = runtime({}, []);
    const { profiles } = await service(rt);
    await expect(profiles.prepare(profiles.resolve(null).turn)).resolves.toBeUndefined();
    expect(rt.checkProfile).not.toHaveBeenCalled();
  });

  it('启动前补做尚未完成的自检；未登录时报错，不换用其他 Profile', async () => {
    const { store, profiles, rt } = await service(
      runtime({ 'claude-code:default': { cliVersion: '0.94.0', login: 'logged_out', reason: null } }),
    );
    const turn = profiles.resolve({ harnessId: 'claude-code', profileId: 'claude-code:default' }).turn;
    await expect(profiles.prepare(turn)).rejects.toThrow('Profile「默认」未登录');
    expect(rt.checkProfile).toHaveBeenCalledTimes(1);
    expect(store.get().defaultSelection.profileId).toBe('codex:default');
    await expect(profiles.prepare(profiles.resolve(null).turn)).resolves.toBeUndefined();
  });

  it('执行服务第一次可用时为全部 Profile 各自检一次，之后的状态更新不重复', async () => {
    const { store, profiles, rt } = await service();
    const status = { available: true, reason: null, version: 'v', sandbox: 's', cwd: '/w', harnesses: rt.harnesses() };
    profiles.onStatus({ ...status, available: false });
    expect(rt.checkProfile).not.toHaveBeenCalled();
    profiles.onStatus(status);
    profiles.onStatus(status);
    await vi.waitFor(() => expect(rt.checkProfile).toHaveBeenCalledTimes(2));
    // 自检在后台写入文件；等结果都已写入再结束，否则 afterEach 删除临时目录时可能与写入竞争（ENOTEMPTY）。
    await vi.waitFor(() => expect(store.get().profiles.every((profile) => profile.check !== null)).toBe(true));
  });
});
