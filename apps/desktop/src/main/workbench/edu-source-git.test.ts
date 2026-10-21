import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { EDU_REQUIRED_FILES } from '@wsl/protocol';
import { collectEduSource } from './edu-source';

const mock = vi.hoisted(() => ({
  run: vi.fn<(binary: string, args: string[], options: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>>(),
}));
vi.mock('node:child_process', () => ({ execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: mock.run }) }));

async function fixture(kind: 'filter' | 'partial-clone' | 'submodule' | 'config-error' | 'none') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-edu-git-'));
  for (const name of EDU_REQUIRED_FILES) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, name);
  }
  mock.run.mockReset();
  mock.run.mockImplementation(async (_binary, args) => {
    if (args.includes('config')) {
      if (kind === 'filter' || kind === 'partial-clone')
        return { stdout: kind === 'filter' ? 'filter.untrusted.clean\n' : 'remote.origin.promisor\n', stderr: '' };
      throw Object.assign(new Error('config result'), {
        code: 1,
        stdout: '',
        stderr: kind === 'config-error' ? 'cannot inspect config' : '',
      });
    }
    if (args.includes('ls-files') && kind === 'submodule') return { stdout: '160000 ' + 'a'.repeat(40) + ' 0\tserver\n', stderr: '' };
    return { stdout: args.includes('--show-toplevel') ? root : args.includes('rev-parse') ? 'a'.repeat(40) : '', stderr: '' };
  });
  return root;
}

describe('source selection cannot execute repository-configured host helpers', () => {
  it.each(['filter', 'partial-clone', 'submodule', 'config-error'] as const)(
    'rejects %s before inspecting worktree status',
    async (kind) => {
      const root = await fixture(kind);
      try {
        await expect(collectEduSource(root, new AbortController().signal)).rejects.toThrow(/过滤器|partial-clone|submodule|Git 配置/);
        expect(mock.run.mock.calls.some(([, args]) => args.includes('status'))).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it('uses the fixed system Git with isolated config, disabled host hooks and no lazy fetch', async () => {
    const root = await fixture('none');
    try {
      await collectEduSource(root, new AbortController().signal);
      for (const [binary, args, options] of mock.run.mock.calls) {
        expect(binary).toBe('/usr/bin/git');
        expect(args).toEqual(expect.arrayContaining(['core.fsmonitor=false', 'core.hooksPath=/dev/null']));
        expect(options.env).toMatchObject({
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_ATTR_NOSYSTEM: '1',
          GIT_NO_LAZY_FETCH: '1',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
        });
        expect(options.env).not.toHaveProperty('SSH_AUTH_SOCK');
      }
      expect(
        mock.run.mock.calls.filter(([, args]) => args.includes('status')).every(([, args]) => args.includes('--ignore-submodules=all')),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
