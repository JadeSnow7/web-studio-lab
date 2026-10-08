import { mkdtemp, rm, writeFile, symlink, mkdir, rename, realpath } from 'node:fs/promises';
import { watch } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileInvalidationHint } from '@wsl/protocol';
import { FileObservationProvider, LocalFileTransport } from './observation-files';
const roots: string[] = [];
const providers: { close(): Promise<void> }[] = [];
async function setup(environmentId = 'local') {
  const root = await mkdtemp(path.join(tmpdir(), 'observation-files-'));
  roots.push(root);
  const files = new FileObservationProvider({
    workspaceId: 'w',
    resourceId: 'files-w',
    instanceId: 'files-instance',
    instanceGeneration: 1,
    environmentId,
    root,
  });
  providers.push(files);
  return { root, files };
}
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('real local file observations', () => {
  it('pins root descriptor and refuses ancestor replacement after authorization', async () => {
    const { root } = await setup();
    const outside = await setup();
    await mkdir(path.join(root, 'parent'));
    await writeFile(path.join(root, 'parent', 'file'), 'inside');
    await writeFile(path.join(outside.root, 'file'), 'SECRET-OUTSIDE');
    const transport = new LocalFileTransport(root);
    providers.push(transport);
    const authorized = await transport.realpath(path.join(root, 'parent', 'file'));
    await rename(path.join(root, 'parent'), path.join(root, 'old-parent'));
    await symlink(outside.root, path.join(root, 'parent'));
    await expect(transport.read(authorized, 1024)).rejects.toMatchObject({ code: 'unauthorized' });
    const canonical = await realpath(root);
    await expect(transport.list(path.join(canonical, 'parent'), 100)).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it('revokes an authorized root after the entire directory is renamed and replaced', async () => {
    const { root, files } = await setup();
    await writeFile(path.join(root, 'x'), 'original');
    expect((await files.read({ path: 'x' })).data.text).toBe('original');
    const retired = root + '-retired';
    await rename(root, retired);
    roots.push(retired);
    await mkdir(root);
    await writeFile(path.join(root, 'x'), 'UNAUTHORIZED_REPLACEMENT');
    for (const operation of [() => files.read({ path: 'x' }), () => files.list(), () => files.search({ query: 'REPLACEMENT' })]) {
      await expect(operation()).rejects.toMatchObject({ code: expect.stringMatching(/^(unauthorized|unavailable)$/) });
    }
    await expect(files.read({ path: 'x' })).rejects.toMatchObject({ code: expect.stringMatching(/^(unauthorized|unavailable)$/) });
  });
  it('does not deliver invalidation hints for an actual filesystem change after close', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'observation-closed-watch-'));
    roots.push(root);
    await writeFile(path.join(root, 'x'), 'before');
    const hints: FileInvalidationHint[] = [];
    const files = new FileObservationProvider({
      workspaceId: 'w',
      resourceId: 'f',
      instanceId: 'i',
      instanceGeneration: 1,
      environmentId: 'local',
      root,
      onInvalidated: (hint) => hints.push(hint),
    });
    providers.push(files);
    await files.read({ path: 'x' });
    const control = watch(root);
    try {
      await files.close();
      await files.close();
      const frozen = structuredClone(hints);
      const delivered = once(control, 'change');
      await writeFile(path.join(root, 'x'), 'after-close');
      await delivered;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(hints).toEqual(frozen);
      expect(hints.filter((hint) => hint.change === 'closed')).toHaveLength(1);
      await expect(files.read({ path: 'x' })).rejects.toMatchObject({ code: 'unavailable' });
    } finally {
      control.close();
    }
  });
  it('keeps UTF-8 whole across bounded continuation and rejects changed versions', async () => {
    const { root, files } = await setup();
    await writeFile(path.join(root, 'text'), 'A中文😀tail');
    const first = await files.read({ path: 'text', maxBytes: 5 });
    expect(first.data).toMatchObject({ text: 'A中', hashScope: 'whole_file' });
    const second = await files.read({ path: 'text', cursor: first.nextCursor, maxBytes: 5 });
    expect(second.data).toMatchObject({ text: '文' });
    await writeFile(path.join(root, 'text'), 'B中文😀tail');
    await expect(files.read({ path: 'text', cursor: first.nextCursor })).rejects.toMatchObject({ code: 'stale_cursor' });
  });
  it('rejects traversal, symlinks outside root and credential reads', async () => {
    const { root, files } = await setup();
    const other = await setup();
    await writeFile(path.join(other.root, 'secret'), 'private');
    await symlink(other.root, path.join(root, 'escape'));
    await expect(files.read({ path: '../secret' })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(files.read({ path: 'escape/secret' })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(files.read({ path: '.env.local' })).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it('keeps editor dirty source distinct from disk and cursor bound to environment', async () => {
    const { root, files } = await setup();
    await writeFile(path.join(root, 'file'), 'disk contents');
    files.setEditor('file', { text: 'unsaved contents', version: 7, dirty: true });
    expect((await files.read({ path: 'file', source: 'editor' })).data).toMatchObject({
      text: 'unsaved contents',
      documentVersion: 7,
      dirty: true,
    });
    const disk = await files.read({ path: 'file', maxBytes: 4 });
    expect(disk.data).toMatchObject({ text: 'disk' });
    expect((await files.read({ path: 'file', source: 'editor' })).resource).toEqual(disk.resource);
    const remoteIdentity = new FileObservationProvider({
      workspaceId: 'w',
      resourceId: 'files-w',
      instanceId: 'files-instance',
      instanceGeneration: 1,
      environmentId: 'ssh:test',
      root,
    });
    providers.push(remoteIdentity);
    await expect(remoteIdentity.read({ path: 'file', cursor: disk.nextCursor })).rejects.toMatchObject({ code: 'stale_cursor' });
    await expect(files.read({ path: 'file', source: 'editor', cursor: disk.nextCursor })).rejects.toMatchObject({ code: 'stale_cursor' });
    files.closeEditor('file');
    await expect(files.read({ path: 'file', source: 'editor' })).rejects.toMatchObject({ code: 'unsupported' });
  });
  it('skips a symlink entry without dropping subsequent real files from search', async () => {
    const { root, files } = await setup();
    await writeFile(path.join(root, 'needle.txt'), 'later needle');
    await symlink('needle.txt', path.join(root, 'first-link'));
    const original = files.transport.list.bind(files.transport);
    vi.spyOn(files.transport, 'list').mockImplementation(async (...args) => {
      const result = await original(...args);
      return { ...result, entries: result.entries.sort((a, b) => Number(b.kind === 'symlink') - Number(a.kind === 'symlink')) };
    });
    expect((await files.search({ query: 'later needle' })).data.matches).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'needle.txt' })]),
    );
  });
  it('recognizes binary content and bounds list and rg search', async () => {
    const { root, files } = await setup();
    await writeFile(path.join(root, 'a.txt'), 'needle\nneedle\n');
    await writeFile(path.join(root, 'b'), Buffer.from([0, 1, 2]));
    await expect(files.read({ path: 'b' })).rejects.toMatchObject({ code: 'unsupported' });
    expect((await files.list({ limit: 1 })).coverage.reasons).toContain('entry_budget');
    const result = await files.search({ query: 'needle', limit: 1 });
    expect(result.data).toMatchObject({ policy: { engine: 'rg', followSymlinks: false } });
  });
});

it.each(['read', 'list', 'search'] as const)('refuses an in-flight %s result after resource generation changes', async (operation) => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const transport = {
    generation: 'old',
    remote: true,
    available: true,
    realpath: async (file: string) => file,
    read: async () => {
      started();
      await gate;
      return Buffer.from('old contents');
    },
    list: async () => {
      started();
      await gate;
      return { entries: [], truncated: false };
    },
  };
  const provider = new FileObservationProvider({
    workspaceId: 'w',
    resourceId: 'files-w',
    instanceId: 'files-instance',
    instanceGeneration: 1,
    environmentId: 'remote',
    root: '/root',
    transport,
  });
  const pending =
    operation === 'read' ? provider.read({ path: 'x' }) : operation === 'list' ? provider.list() : provider.search({ query: 'x' });
  await entered;
  transport.generation = 'new';
  transport.available = false;
  release();
  await expect(pending).rejects.toMatchObject({ code: 'unavailable' });
});

it('uses the explicit resource and instance for source, read and watch, then closes once', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'observation-identity-'));
  roots.push(root);
  await writeFile(path.join(root, 'x'), 'bound contents');
  const hints: FileInvalidationHint[] = [];
  const resource = {
    workspaceId: 'other-workspace',
    environmentId: 'local',
    resourceId: 'stable-file',
    kind: 'file' as const,
    instanceId: 'file-instance',
    instanceGeneration: 3,
  };
  const files = new FileObservationProvider({ ...resource, root, onInvalidated: (hint) => hints.push(hint) });
  providers.push(files);
  expect(files.source().resource).toEqual(resource);
  expect((await files.read({ path: 'x' })).resource).toEqual(resource);
  await files.close();
  await files.close();
  for (const hint of hints) expect(hint).toMatchObject({ ...resource, coverage: { lossy: true } });
  expect(hints.map((hint) => hint.sequence)).toEqual(hints.map((_hint, index) => index + 1));
  expect(hints.filter((hint) => hint.change === 'closed')).toHaveLength(1);
  expect(hints.at(-1)?.change).toBe('closed');
  await expect(files.read({ path: 'x' })).rejects.toMatchObject({ code: 'unavailable' });
});
it('refuses a remote read that completes after its provider is closed', async () => {
  let release: (() => void) | undefined;
  const transport = {
    generation: 'g',
    remote: true,
    available: true,
    realpath: async (file: string) => file,
    read: async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return Buffer.from('late');
    },
    list: async () => ({ entries: [], truncated: false }),
  };
  const files = new FileObservationProvider({
    workspaceId: 'w',
    environmentId: 'ssh:test',
    resourceId: 'file-a',
    instanceId: 'i',
    instanceGeneration: 1,
    root: '/root',
    transport,
  });
  const pending = files.read({ path: 'x' });
  await expect.poll(() => typeof release).toBe('function');
  await files.close();
  release?.();
  await expect(pending).rejects.toMatchObject({ code: 'unavailable' });
});

it('cancelled file requests refuse the result without changing a different instance', async () => {
  const { root, files } = await setup();
  await writeFile(path.join(root, 'x'), 'cancelled');
  const cancellation = new AbortController();
  const original = files.transport.read.bind(files.transport);
  vi.spyOn(files.transport, 'read').mockImplementation(async (...args) => {
    const result = await original(...args);
    cancellation.abort();
    return result;
  });
  await expect(files.read({ path: 'x' }, Date.now() + 5000, cancellation.signal)).rejects.toMatchObject({ code: 'cancelled' });
  expect(files.source().available).toBe(true);
});

it('reports SFTP provenance for remote images while preserving the Main resource identity', async () => {
  const resource = {
    workspaceId: 'w-image',
    environmentId: 'ssh',
    resourceId: 'file-image',
    instanceId: 'image-instance',
    instanceGeneration: 4,
  };
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const files = new FileObservationProvider({
    ...resource,
    root: '/authorized',
    transport: {
      generation: 'connection-image',
      remote: true,
      available: true,
      realpath: async (file: string) => file,
      read: async () => bytes,
      list: async () => ({ entries: [], truncated: false }),
    },
  });
  providers.push(files);
  expect(await files.read({ path: 'image.png' })).toMatchObject({
    source: 'sftp',
    resource: { ...resource, kind: 'file' },
    data: { mediaType: 'image/png' },
  });
});
