import { open, readFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { JournalEvent } from './contract';

/**
 * 合同 §7 的 JSONL journal 适配器：每条记录 append + fsync 后才返回。
 * 所有写入经内部 promise 链串行化，保证文件内顺序即调用顺序。
 */
export class JsonlJournal {
  private handle: FileHandle;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(handle: FileHandle) {
    this.handle = handle;
  }

  static filePath(dir: string, runId: string): string {
    return path.join(dir, `${runId}.jsonl`);
  }

  static async open(dir: string, runId: string): Promise<JsonlJournal> {
    const handle = await open(JsonlJournal.filePath(dir, runId), 'a');
    return new JsonlJournal(handle);
  }

  append(event: JournalEvent): Promise<void> {
    if (this.closed) return Promise.reject(new Error('journal closed'));
    const line = JSON.stringify(event) + '\n';
    this.tail = this.tail.then(async () => {
      await this.handle.appendFile(line, 'utf8');
      await this.handle.sync();
    });
    return this.tail;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.tail.catch(() => undefined);
    await this.handle.close();
  }
}

export async function readJournal(path: string): Promise<JournalEvent[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JournalEvent);
}
