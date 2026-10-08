import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import type { Observation, FileInvalidationHint, ResourceInstanceIdentity } from '@wsl/protocol';
import { LocalFileWatch } from './local-file-watch';

const MAX_FILE = 8 * 1024 * 1024;
const MAX_READ = 64 * 1024;
const MAX_IMAGE = 700000;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export class FileObservationError extends Error {
  constructor(
    public readonly code: 'not_found' | 'unauthorized' | 'unsupported' | 'unavailable' | 'stale_cursor' | 'cancelled',
    message: string,
  ) {
    super(message);
  }
}
export interface FileTransport {
  readonly generation: string;
  readonly remote: boolean;
  readonly available?: boolean;
  realpath(file: string, deadline?: number): Promise<string>;
  read(file: string, maxBytes: number, deadline?: number): Promise<Buffer>;
  list(file: string, limit: number, deadline?: number): Promise<{ entries: { name: string; kind: string }[]; truncated: boolean }>;
}
// Python supplies openat/dir_fd, unavailable in Node's filesystem API. Descriptor 3 is
// the pinned workspace root. Every descendant is opened relative to an already-open
// directory with O_NOFOLLOW; a concurrent rename cannot redirect traversal outside it.
const LOCAL_READER = String.raw`
import os,sys,json,stat,base64,errno
fds=[]
def fail(code):
 print(json.dumps({'error':code}));sys.exit(0)
try:
 mode,relative,budget=sys.argv[1:];budget=int(budget)
 parts=[p for p in relative.split('/') if p and p!='.']
 if any(p=='..' for p in parts): fail('unauthorized')
 current=3
 for part in parts[:-1]:
  current=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=current);fds.append(current)
 if parts:
  current=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|(os.O_DIRECTORY if mode=='list' else 0),dir_fd=current);fds.append(current)
 if mode=='list':
  entries=[];truncated=False
  with os.scandir(current) as directory:
   for item in directory:
    if len(entries)>=budget: truncated=True;break
    kind='symlink' if item.is_symlink() else 'directory' if item.is_dir(follow_symlinks=False) else 'file' if item.is_file(follow_symlinks=False) else 'other'
    entries.append({'name':item.name,'kind':kind})
  print(json.dumps({'entries':entries,'truncated':truncated}))
 else:
  before=os.fstat(current)
  if not stat.S_ISREG(before.st_mode) or before.st_size>budget: fail('unsupported')
  chunks=[];count=0
  while count<=budget:
   chunk=os.read(current,min(65536,budget+1-count))
   if not chunk: break
   chunks.append(chunk);count+=len(chunk)
  after=os.fstat(current)
  if count>budget or (before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_size,after.st_mtime_ns,after.st_ctime_ns): fail('stale_cursor')
  print(json.dumps({'base64':base64.b64encode(b''.join(chunks)).decode('ascii')}))
except OSError as error:
 fail('unauthorized' if error.errno in [errno.ELOOP,errno.ENOTDIR,errno.EACCES,errno.EPERM] else 'not_found' if error.errno==errno.ENOENT else 'unavailable')
finally:
 for fd in reversed(fds): os.close(fd)
`;
export class LocalFileTransport implements FileTransport {
  generation = randomUUID();
  readonly remote = false;
  available = true;
  watcher?: LocalFileWatch;
  private rootHandle?: Promise<{ handle: FileHandle; canonical: string }>;
  constructor(private readonly root: string) {}
  private pinnedRoot() {
    if (!this.available) throw new FileObservationError('unavailable', 'Workspace root is closed or replaced');
    this.rootHandle ??= (async () => {
      const canonical = await realpath(this.root);
      const expected = await stat(canonical);
      const handle = await open(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const actual = await handle.stat();
      if (expected.ino !== actual.ino || expected.dev !== actual.dev) {
        await handle.close();
        throw new FileObservationError('unauthorized', 'Workspace root changed during authorization');
      }
      return { handle, canonical };
    })();
    return this.rootHandle;
  }
  invalidateRoot() {
    this.available = false;
    this.generation = randomUUID();
  }
  async close() {
    this.watcher?.close();
    if (this.available) this.invalidateRoot();
    if (this.rootHandle) {
      const root = await this.rootHandle;
      await root.handle.close();
      this.rootHandle = undefined;
    }
  }
  async realpath(file: string) {
    try {
      await this.pinnedRoot();
      return await realpath(file);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      throw new FileObservationError(
        code === 'ENOENT' ? 'not_found' : code === 'EACCES' || code === 'EPERM' ? 'unauthorized' : 'unavailable',
        'File path is unavailable',
      );
    }
  }
  private async capture(mode: 'read' | 'list', file: string, budget: number, deadline: number): Promise<Record<string, unknown>> {
    const generation = this.generation;
    const root = await this.pinnedRoot();
    this.watcher?.authorizeRoot(await root.handle.stat(), root.canonical);
    await this.watcher?.observe(mode === 'list' ? file : path.dirname(file));
    if (!this.available) throw new FileObservationError('unavailable', 'Workspace root was replaced');
    const relative = path.relative(root.canonical, file);
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative))
      throw new FileObservationError('unauthorized', 'Path outside pinned workspace root');
    return new Promise((resolve, reject) => {
      const child = spawn('python3', ['-I', '-c', LOCAL_READER, mode, relative, String(budget)], {
        stdio: ['ignore', 'pipe', 'ignore', root.handle.fd],
      });
      const chunks: Buffer[] = [];
      let length = 0;
      let timedOut = false;
      const timer = setTimeout(
        () => {
          timedOut = true;
          child.kill('SIGKILL');
        },
        Math.max(1, deadline - Date.now()),
      );
      child.stdout?.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > 12 * 1024 * 1024) child.kill('SIGKILL');
        else chunks.push(chunk);
      });
      child.once('error', () => {
        clearTimeout(timer);
        reject(new FileObservationError('unavailable', 'Python 3 secure file reader unavailable'));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 || timedOut) {
          reject(new FileObservationError('unavailable', 'Secure file reader exceeded budget or failed'));
          return;
        }
        try {
          if (!this.available || this.generation !== generation)
            throw new FileObservationError('unavailable', 'File resource changed during capture');
          const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid reader response');
          if ('error' in data) {
            const code = data.error;
            throw new FileObservationError(
              code === 'unauthorized' || code === 'not_found' || code === 'unsupported' || code === 'stale_cursor' ? code : 'unavailable',
              'Secure file read refused',
            );
          }
          resolve(data as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      });
    });
  }
  async read(file: string, maxBytes: number, deadline = Date.now() + 5000) {
    const data = await this.capture('read', file, maxBytes, deadline);
    if (typeof data.base64 !== 'string') throw new FileObservationError('unavailable', 'Invalid reader response');
    return Buffer.from(data.base64, 'base64');
  }
  async list(file: string, limit: number, deadline = Date.now() + 5000) {
    const data = await this.capture('list', file, limit, deadline);
    if (!Array.isArray(data.entries) || typeof data.truncated !== 'boolean')
      throw new FileObservationError('unavailable', 'Invalid reader response');
    const entries: { name: string; kind: string }[] = [];
    for (const entry of data.entries) {
      if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || typeof entry.kind !== 'string')
        throw new FileObservationError('unavailable', 'Invalid directory entry');
      entries.push({ name: entry.name, kind: entry.kind });
    }
    return { entries, truncated: data.truncated };
  }
}
interface EditorState {
  text: string;
  version: number;
  dirty: boolean;
  selection?: { start: number; end: number };
}
interface Cursor {
  file: string;
  source: string;
  generation: string;
  hash: string;
  offset: number;
}
export interface FileProviderOptions {
  workspaceId: string;
  environmentId: string;
  resourceId: string;
  instanceId: string;
  instanceGeneration: number;
  root: string;
  transport?: FileTransport;
  onInvalidated?: (hint: FileInvalidationHint) => void;
}
export class FileObservationProvider {
  readonly transport: FileTransport;
  private closed = false;
  private readonly identity: ResourceInstanceIdentity & { kind: 'file' };
  private readonly editors = new Map<string, EditorState>();
  private readonly cursors = new Map<string, Cursor>();
  constructor(private readonly options: FileProviderOptions) {
    this.identity = Object.freeze({
      workspaceId: options.workspaceId,
      environmentId: options.environmentId,
      resourceId: options.resourceId,
      kind: 'file',
      instanceId: options.instanceId,
      instanceGeneration: options.instanceGeneration,
    });
    this.transport = options.transport ?? new LocalFileTransport(options.root);
    if (this.transport instanceof LocalFileTransport) {
      const transport = this.transport;
      transport.watcher = new LocalFileWatch(
        path.resolve(options.root),
        (hint) =>
          options.onInvalidated?.({
            ...hint,
            ...this.identity,
            generation: transport.generation,
            coverage: { scope: 'observed-directories', recursive: false, lossy: true },
          }),
        () => transport.invalidateRoot(),
      );
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.cursors.clear();
    this.editors.clear();
    if (this.transport instanceof LocalFileTransport) await this.transport.close();
  }
  source() {
    return {
      resource: this.identity,
      generation: this.transport.generation,
      name: this.transport.remote ? 'SSH files' : 'Workspace files',
      capabilities: ['files.list', 'files.search', 'files.read', ...(this.editors.size ? ['editor'] : [])],
      available: !this.closed && (this.transport.available ?? true),
      watch:
        this.transport instanceof LocalFileTransport
          ? this.transport.watcher?.status()
          : { supported: false, reason: 'SFTP watch unsupported' },
    };
  }
  private normalize(file: string) {
    const p = this.transport.remote ? path.posix : path;
    const candidate = p.resolve(this.options.root, file);
    const relative = p.relative(this.options.root, candidate);
    if (relative.startsWith('..' + p.sep) || relative === '..' || p.isAbsolute(relative))
      throw new FileObservationError('unauthorized', 'Path outside workspace');
    // These files never enter ordinary model context, including explicit reads.
    if (
      relative
        .split(p.sep)
        .some(
          (part) =>
            ['.ssh', '.aws', '.codex', '.git'].includes(part) ||
            /^\.env(?:\.|$)/.test(part) ||
            /^(?:id_rsa|id_ed25519|credentials|auth\.json)$/.test(part),
        )
    )
      throw new FileObservationError('unauthorized', 'Credential or private metadata path');
    return candidate;
  }
  private async resolve(file: string, deadline = Date.now() + 5000) {
    const candidate = this.normalize(file);
    const root = await this.transport.realpath(this.options.root, deadline);
    const actual = await this.transport.realpath(candidate, deadline);
    const p = this.transport.remote ? path.posix : path;
    const relative = p.relative(root, actual);
    if (relative === '..' || relative.startsWith('../') || p.isAbsolute(relative))
      throw new FileObservationError('unauthorized', 'Symlink leaves workspace');
    this.normalize(p.resolve(this.options.root, relative));
    return actual;
  }
  setEditor(file: string, editor: EditorState) {
    if (Buffer.byteLength(editor.text) > MAX_FILE || (!this.editors.has(this.normalize(file)) && this.editors.size >= 32))
      throw new FileObservationError('unsupported', 'Editor snapshot budget exceeded');
    this.editors.set(this.normalize(file), { ...editor });
  }
  closeEditor(file: string) {
    this.editors.delete(this.normalize(file));
  }
  private observation(
    file: string,
    source: string,
    data: Record<string, unknown>,
    hash: string,
    partial: boolean,
    range?: Record<string, unknown>,
    reasons: string[] = [],
  ): Observation {
    return {
      resource: this.identity,
      generation: this.transport.generation,
      revision: { value: hash, strength: 'content-hash' },
      snapshotId: randomUUID(),
      capturedAt: new Date().toISOString(),
      source,
      representation: 'json',
      coverage: { status: partial ? 'partial' : 'complete', range, reasons },
      data: {
        ...data,
        watch:
          this.transport instanceof LocalFileTransport
            ? this.transport.watcher?.status(Array.isArray(data.entries) || Array.isArray(data.matches) ? file : path.dirname(file))
            : { supported: false, reason: 'SFTP watch unsupported' },
      },
    };
  }
  private async stable<T>(operation: (assertActive: () => void) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const generation = this.transport.generation;
    const assertActive = () => {
      if (signal?.aborted) throw new FileObservationError('cancelled', 'File observation cancelled');
      this.assertCurrent(generation);
    };
    assertActive();
    const result = await operation(assertActive);
    assertActive();
    return result;
  }
  private assertCurrent(generation: string) {
    if (this.closed || this.transport.available === false || this.transport.generation !== generation)
      throw new FileObservationError('unavailable', 'File resource changed during observation');
  }
  read(
    input: { path: string; source?: 'disk' | 'editor'; cursor?: string; maxBytes?: number },
    deadline = Date.now() + 5000,
    signal?: AbortSignal,
  ) {
    return this.stable((assertActive) => this.readCurrent(input, deadline, assertActive), signal);
  }
  private async readCurrent(
    input: { path: string; source?: 'disk' | 'editor'; cursor?: string; maxBytes?: number },
    deadline = Date.now() + 5000,
    assertActive: () => void,
  ): Promise<Observation> {
    const source = input.source ?? 'disk';
    const effectiveSource = source === 'disk' && this.transport.remote ? 'sftp' : source;
    const normalized = this.normalize(input.path);
    const editor = source === 'editor' ? this.editors.get(normalized) : undefined;
    if (source === 'editor' && !editor) throw new FileObservationError('unsupported', 'No open editor document model for this resource');
    const file = source === 'editor' ? normalized : await this.resolve(input.path, deadline);
    assertActive();
    const bytes = editor ? Buffer.from(editor.text) : await this.transport.read(file, MAX_FILE, deadline);
    if (bytes.length > MAX_FILE) throw new FileObservationError('unsupported', 'Document exceeds snapshot budget');
    const hash = digest(bytes);
    const version = editor ? `${editor.version}:${hash}` : hash;
    const cursor = input.cursor ? this.cursors.get(input.cursor) : undefined;
    if (
      input.cursor &&
      (!cursor ||
        cursor.file !== file ||
        cursor.hash !== version ||
        cursor.source !== source ||
        cursor.generation !== this.transport.generation)
    )
      throw new FileObservationError('stale_cursor', 'Cursor does not match current resource, source, connection or content');
    const offset = cursor?.offset ?? 0;
    const limit = Math.max(4, Math.min(MAX_READ, input.maxBytes ?? 16384));
    const ext = path.extname(file).toLowerCase();
    const image = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? 'image/png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        ? 'image/jpeg'
        : /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))
          ? 'image/gif'
          : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
            ? 'image/webp'
            : undefined;
    if (image)
      return this.observation(
        normalized,
        effectiveSource,
        {
          path: input.path,
          mediaType: image,
          size: bytes.length,
          contentSha256: hash,
          imageInputRequired: true,
          imageAvailable: bytes.length <= MAX_IMAGE,
          ...(bytes.length <= MAX_IMAGE ? { base64: bytes.toString('base64') } : {}),
        },
        hash,
        bytes.length > MAX_IMAGE,
        { bytes: bytes.length },
        bytes.length > MAX_IMAGE ? ['Image exceeds inline image budget'] : [],
      );
    if (bytes.includes(0) || ['.pdf', '.doc', '.docx', '.xlsx', '.pptx', '.zip'].includes(ext))
      throw new FileObservationError('unsupported', `No parser for ${ext || 'binary'}; ${bytes.length} bytes`);
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new FileObservationError('unsupported', 'Text encoding is not UTF-8');
    }
    let end = Math.min(bytes.length, offset + limit);
    while (end < bytes.length && (bytes[end] ?? 0) >> 6 === 2) end--;
    const fragment = bytes.subarray(offset, end).toString('utf8');
    const result = this.observation(
      normalized,
      effectiveSource,
      {
        path: input.path,
        text: fragment,
        encoding: 'utf-8',
        totalBytes: bytes.length,
        contentSha256: hash,
        hashScope: 'whole_file',
        captureConsistency: editor ? 'document_version' : 'best_effort_size_time_checks; concurrent in-place writes are not atomic',
        fragmentSha256: digest(fragment),
        ...(editor ? { documentVersion: editor.version, dirty: editor.dirty, selection: editor.selection } : {}),
        buildContentVersion: 'unknown',
      },
      version,
      end < bytes.length || offset > 0,
      {
        startByte: offset,
        endByteExclusive: end,
        startLine: bytes.subarray(0, offset).toString('utf8').split('\n').length,
        endLine: bytes.subarray(0, end).toString('utf8').split('\n').length,
      },
      end < bytes.length ? ['read_budget'] : [],
    );
    if (end < bytes.length) {
      const key = randomUUID();
      this.cursors.set(key, { file, source, generation: this.transport.generation, hash: version, offset: end });
      if (this.cursors.size > 512) {
        const oldest = this.cursors.keys().next().value;
        if (oldest) this.cursors.delete(oldest);
      }
      result.nextCursor = key;
    }
    return result;
  }
  list(input: { path?: string; limit?: number } = {}, signal?: AbortSignal): Promise<Observation> {
    return this.stable((assertActive) => this.listCurrent(input, assertActive), signal);
  }
  private async listCurrent(input: { path?: string; limit?: number }, assertActive: () => void): Promise<Observation> {
    const deadline = Date.now() + 5000;
    const file = await this.resolve(input.path ?? '.', deadline);
    assertActive();
    const { entries, truncated } = await this.transport.list(file, Math.max(1, Math.min(500, input.limit ?? 100)), deadline);
    const visible = entries.filter((entry) => {
      try {
        this.normalize(path.posix.join(input.path ?? '.', entry.name));
        return true;
      } catch {
        return false;
      }
    });
    return this.observation(
      this.normalize(input.path ?? '.'),
      this.transport.remote ? 'sftp' : 'disk',
      { entries: visible, policy: 'credential_paths_excluded; symlinks_listed_not_followed' },
      digest(JSON.stringify(visible)),
      true,
      { returned: visible.length },
      [
        truncated ? 'entry_budget' : 'directory_snapshot_not_atomic',
        ...(visible.length < entries.length ? ['credential_paths_excluded'] : []),
      ],
    );
  }
  search(input: { path?: string; query: string; limit?: number }, signal?: AbortSignal): Promise<Observation> {
    return this.stable((assertActive) => this.searchCurrent(input, assertActive), signal);
  }
  private async searchCurrent(input: { path?: string; query: string; limit?: number }, assertActive: () => void): Promise<Observation> {
    if (!input.query || input.query.length > 512 || input.query.includes('\0'))
      throw new FileObservationError('unsupported', 'Query must contain 1–512 characters');
    const deadline = Date.now() + 5000;
    await this.resolve(input.path ?? '.', deadline);
    const limit = Math.max(1, Math.min(100, input.limit ?? 50));
    const matches: { path: string; line: number; text: string }[] = [];
    const queue = [input.path ?? '.'];
    let scanned = 0;
    while (queue.length && scanned < 100 && matches.length < limit && Date.now() < deadline) {
      assertActive();
      const dir = queue.shift();
      if (!dir) break;
      const listing = await this.transport.list(await this.resolve(dir, deadline), 100, deadline);
      for (const entry of listing.entries) {
        if (entry.name.startsWith('.')) continue;
        const relative = path.posix.join(dir, entry.name);
        if (entry.kind === 'directory') {
          if (queue.length < 100) queue.push(relative);
          continue;
        }
        if (entry.kind !== 'file') continue;
        if (++scanned > 100 || matches.length >= limit || Date.now() >= deadline) break;
        try {
          const result = await this.read({ path: relative, maxBytes: MAX_READ }, deadline);
          const data = result.data;
          if (typeof data !== 'object' || !data || !('text' in data) || typeof data.text !== 'string') continue;
          if (!this.transport.remote) {
            const stdout = await new Promise<string>((resolve, reject) => {
              const child = execFile(
                'rg',
                ['--json', '--fixed-strings', '--max-count', String(limit), '--', input.query],
                { encoding: 'utf8', timeout: Math.max(1, deadline - Date.now()), maxBuffer: 1024 * 1024 },
                (error, output) => {
                  if (error && error.code !== 1) reject(new FileObservationError('unavailable', 'rg search failed or exceeded budget'));
                  else resolve(output);
                },
              );
              child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
                if (error.code !== 'EPIPE') reject(error);
              });
              child.stdin?.end(data.text);
            });
            for (const line of stdout.split('\n').filter(Boolean)) {
              const event = JSON.parse(line);
              if (
                event.type === 'match' &&
                typeof event.data?.line_number === 'number' &&
                typeof event.data?.lines?.text === 'string' &&
                matches.length < limit
              )
                matches.push({ path: relative, line: event.data.line_number, text: event.data.lines.text.trimEnd().slice(0, 2000) });
            }
          } else
            data.text.split('\n').forEach((line, i) => {
              if (line.includes(input.query) && matches.length < limit)
                matches.push({ path: relative, line: i + 1, text: line.slice(0, 2000) });
            });
        } catch (error) {
          if (!(error instanceof FileObservationError && ['unsupported', 'unauthorized'].includes(error.code))) throw error;
        }
      }
    }
    return this.observation(
      this.normalize(input.path ?? '.'),
      this.transport.remote ? 'sftp-search' : 'disk-search',
      {
        matches,
        scannedFiles: scanned,
        policy: {
          engine: this.transport.remote ? 'sftp-bounded-scan' : 'rg',
          hidden: false,
          followSymlinks: false,
          maxFiles: 100,
          bytesPerFile: MAX_READ,
          ignores: false,
          input: 'captured-bytes-only',
        },
      },
      digest(JSON.stringify(matches)),
      true,
      { returned: matches.length },
      ['bounded_scan; no index; first 64 KiB per file; directory limit 100; ignore files not applied'],
    );
  }
}
