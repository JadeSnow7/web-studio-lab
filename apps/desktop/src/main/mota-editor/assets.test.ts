import { mkdtemp, writeFile, rm, symlink, unlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { MotaEditorAssets, EDITOR_CSP, type EditorAssetManifest } from './assets';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mota-assets-'));
  roots.push(root);
  const files = ['LICENSES.txt', 'editor.css', 'editor.js', 'index.html'].map((name) => ({
    path: name,
    length: name.length,
    sha256: hash(name),
  }));
  for (const file of files) await writeFile(path.join(root, file.path), file.path);
  const manifest: EditorAssetManifest = { schemaVersion: 1, version: hash(JSON.stringify(files)), files };
  return { root, manifest, assets: new MotaEditorAssets(root, manifest) };
}
describe('embedded-manifest editor assets', () => {
  it('returns the validated bytes with strict CSP and MIME', async () => {
    const f = await fixture();
    await f.assets.validate();
    const response = await f.assets.response('wsl-editor://mota/index.html');
    expect(await response.text()).toBe('index.html');
    expect(response.headers.get('content-security-policy')).toBe(EDITOR_CSP);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(EDITOR_CSP).toContain("worker-src 'none'");
    expect(EDITOR_CSP).not.toMatch(/unsafe|http/);
  });
  it.each([
    'wsl-editor://mota/index.html?q=1',
    'wsl-editor://mota/index.html#hash',
    'wsl-editor://other/index.html',
    'wsl-editor://mota/unknown.js',
    'wsl-editor://mota/../index.html',
    'wsl-editor://mota/%69ndex.html',
  ])('rejects noncanonical route %s', async (url) => {
    const f = await fixture();
    await expect(f.assets.response(url)).rejects.toThrow();
  });
  it('rejects missing and tampered assets against the embedded expectation, ignoring sidecar changes', async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, 'manifest.json'), JSON.stringify({ compromised: true }));
    await writeFile(path.join(f.root, 'editor.js'), 'malicious');
    await expect(f.assets.bytes('editor.js')).rejects.toThrow('校验');
    await unlink(path.join(f.root, 'editor.css'));
    await expect(f.assets.validate()).rejects.toThrow();
    expect(() => new MotaEditorAssets(f.root, { ...f.manifest, version: '0'.repeat(64) })).toThrow('清单');
  });
  it('rejects asset and output directory symlinks', async () => {
    const f = await fixture();
    await unlink(path.join(f.root, 'editor.js'));
    await symlink(path.join(f.root, 'index.html'), path.join(f.root, 'editor.js'));
    await expect(f.assets.bytes('editor.js')).rejects.toThrow('独立文件');
    const alias = f.root + '-link';
    roots.push(alias);
    await symlink(f.root, alias);
    await expect(new MotaEditorAssets(alias, f.manifest).bytes('index.html')).rejects.toThrow('目录');
  });
});
