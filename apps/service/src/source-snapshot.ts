import {
  AppSourceSnapshotSchema,
  SourceSnapshotFrameSchema,
  SOURCE_MAX_BYTES,
  SOURCE_MAX_FILES,
  SOURCE_TRANSPORT_MAX_BYTES,
  type AppSourceSnapshot,
  type AppTarget,
} from '@wsl/protocol';

export class SourceSnapshotReader {
  private pending = '';
  private received = 0;
  private totalBytes = 0;
  private complete = false;
  private files: AppSourceSnapshot['files'] = [];
  private current: { path: string; mode: '100644' | '100755'; chunks: string[]; padded: boolean } | null = null;

  accept(text: string): void {
    this.received += Buffer.byteLength(text);
    if (this.received > SOURCE_TRANSPORT_MAX_BYTES) throw new Error('源码传输超过 352 MiB');
    this.pending += text;
    let end: number;
    while ((end = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, end);
      this.pending = this.pending.slice(end + 1);
      if (line.length > 96 * 1024 || !line.startsWith('WSL_SOURCE:') || this.complete) throw new Error('无效源码采集帧');
      const parsed = SourceSnapshotFrameSchema.safeParse(JSON.parse(line.slice('WSL_SOURCE:'.length)));
      if (!parsed.success) throw new Error('源码采集帧校验失败');
      const frame = parsed.data;
      if (frame.type === 'file') {
        if (this.current || this.files.length >= SOURCE_MAX_FILES) throw new Error('源码文件数量或顺序无效');
        this.current = { path: frame.path, mode: frame.mode, chunks: [], padded: false };
      } else if (frame.type === 'chunk') {
        if (!this.current || this.current.padded || !frame.base64.length) throw new Error('源码分块顺序无效');
        this.totalBytes += Buffer.from(frame.base64, 'base64').length;
        if (this.totalBytes > SOURCE_MAX_BYTES) throw new Error('源码超过 200 MiB');
        this.current.chunks.push(frame.base64);
        this.current.padded = frame.base64.endsWith('=');
      } else if (frame.type === 'end-file') {
        if (!this.current) throw new Error('源码文件结束帧无效');
        this.files.push({ path: this.current.path, mode: this.current.mode, base64: this.current.chunks.join('') });
        this.current = null;
      } else {
        if (this.current || frame.totalBytes !== this.totalBytes || frame.fileCount !== this.files.length)
          throw new Error('源码完整性回执不一致');
        this.complete = true;
      }
    }
    if (this.pending.length > 96 * 1024) throw new Error('源码分块超过预算');
  }

  result(target: AppTarget): AppSourceSnapshot {
    if (!this.complete || this.current || this.pending) throw new Error('源码快照未完整返回');
    const parsed = AppSourceSnapshotSchema.safeParse({ ...target, files: this.files, totalBytes: this.totalBytes });
    if (!parsed.success) throw new Error('源码快照路径、编码或预算校验失败');
    return parsed.data;
  }
}
