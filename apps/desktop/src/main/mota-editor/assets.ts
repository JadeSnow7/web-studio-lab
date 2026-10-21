import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import type { Session } from 'electron';

export type EditorAssetManifest = { schemaVersion: 1; version: string; files: { path: string; length: number; sha256: string }[] };
declare const __MOTA_EDITOR_MANIFEST__: EditorAssetManifest;
export const EDITOR_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'";
export const embeddedEditorManifest = () => __MOTA_EDITOR_MANIFEST__;
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const routes: Record<string, string> = {
  'index.html': 'text/html; charset=utf-8',
  'editor.js': 'text/javascript; charset=utf-8',
  'editor.css': 'text/css; charset=utf-8',
  'LICENSES.txt': 'text/plain; charset=utf-8',
};

export class MotaEditorAssets {
  readonly manifestDigest: string;
  constructor(
    private readonly root: string,
    readonly manifest: EditorAssetManifest,
  ) {
    if (
      manifest.schemaVersion !== 1 ||
      manifest.version !== hash(JSON.stringify(manifest.files)) ||
      JSON.stringify(manifest.files.map((file) => file.path)) !== JSON.stringify(Object.keys(routes).sort())
    )
      throw new Error('编辑器资产清单无效');
    this.manifestDigest = hash(JSON.stringify(manifest));
  }
  async bytes(name: string): Promise<Buffer> {
    const entry = this.manifest.files.find((file) => file.path === name);
    if (!entry || !Object.hasOwn(routes, name)) throw new Error('未知编辑器资产');
    // Check every ancestor; neither asset nor output links can redirect trust outside this tree.
    let current = path.resolve(this.root);
    while (true) {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('编辑器资产目录不可信');
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    const file = path.join(this.root, name);
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('编辑器资产不是独立文件');
    const handle = await open(file, 'r');
    let bytes: Buffer;
    try {
      const actual = await handle.stat();
      if (actual.dev !== before.dev || actual.ino !== before.ino || !actual.isFile() || actual.nlink !== 1 || actual.size !== entry.length)
        throw new Error('编辑器资产被替换');
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    const after = await lstat(file);
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino)
      throw new Error('编辑器资产读取期间被替换');
    if (bytes.length !== entry.length || hash(bytes) !== entry.sha256) throw new Error('编辑器资产校验失败');
    return bytes;
  }
  async validate(): Promise<void> {
    for (const file of this.manifest.files) await this.bytes(file.path);
  }
  async response(url: string): Promise<Response> {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'wsl-editor:' ||
      parsed.hostname !== 'mota' ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      url !== 'wsl-editor://mota' + parsed.pathname
    )
      throw new Error('编辑器资产地址无效');
    const name = parsed.pathname.slice(1);
    const bytes = await this.bytes(name);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': routes[name]!,
        'Content-Security-Policy': EDITOR_CSP,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  }
  install(target: Session, failure: () => void) {
    target.protocol.handle('wsl-editor', async (request) => {
      try {
        return await this.response(request.url);
      } catch {
        failure();
        return new Response('编辑器资产不可用', { status: 403, headers: { 'Content-Security-Policy': EDITOR_CSP } });
      }
    });
  }
}
