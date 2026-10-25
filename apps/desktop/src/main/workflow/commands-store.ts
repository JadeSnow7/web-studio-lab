import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/**
 * W5 已保存命令的文件仓储：userData/workflow/commands.json。
 * - 原子写：先写 .tmp 再 rename，避免半文件被当成有效仓储。
 * - zod strict 校验：带未知字段（含注入的 input）的记录使整个文件视为损坏。
 * - 损坏文件 fail-closed：builtin 命令照常可用、saved 列表为空并记录 error，
 *   不静默放行部分记录，也不覆盖损坏文件。
 */
export const SavedWorkflowCommandSchema = z
  .object({
    commandId: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    script: z
      .string()
      .min(1)
      .max(64 * 1024),
    args: z.unknown().optional(),
    deadlineMs: z.number().int().positive().max(600_000),
    createdMs: z.number().int().nonnegative(),
    updatedMs: z.number().int().nonnegative(),
    /** 显式批准时绑定的 contentHash；内容改动后须重新批准才可运行。 */
    approvedHash: z.string().min(1).optional(),
  })
  .strict();
export type SavedWorkflowCommand = z.infer<typeof SavedWorkflowCommandSchema>;

const CommandsFileSchema = z.object({ version: z.literal(1), commands: z.array(SavedWorkflowCommandSchema) }).strict();

export class WorkflowCommandsStoreError extends Error {
  readonly code = 'command_store_corrupt';
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowCommandsStoreError';
  }
}

export class WorkflowCommandsStore {
  private commands = new Map<string, SavedWorkflowCommand>();
  private loadError: string | null = null;
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** 损坏文件的失败原因；未损坏为 null。只读，供诊断与测试断言。 */
  get error(): string | null {
    return this.loadError;
  }

  /** 加载一次；文件不存在按空仓储处理，解析/zod 失败记 error 且 saved 为空。 */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.loadError = error instanceof Error ? error.message : String(error);
      return;
    }
    try {
      const parsed = CommandsFileSchema.parse(JSON.parse(text));
      const seen = new Map<string, SavedWorkflowCommand>();
      for (const command of parsed.commands) seen.set(command.commandId, command);
      this.commands = seen;
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
    }
  }

  list(): SavedWorkflowCommand[] {
    return [...this.commands.values()].sort((a, b) => a.createdMs - b.createdMs || a.commandId.localeCompare(b.commandId));
  }

  get(commandId: string): SavedWorkflowCommand | null {
    return this.commands.get(commandId) ?? null;
  }

  /** 新建或覆盖一条 saved 命令；approvedHash 由调用方决定（保存即丢弃批准）。 */
  async put(command: SavedWorkflowCommand): Promise<void> {
    this.commands.set(command.commandId, SavedWorkflowCommandSchema.parse(command));
    await this.persist();
  }

  /** 仅更新 approvedHash；未知 id 返回 false。 */
  async setApprovedHash(commandId: string, approvedHash: string): Promise<boolean> {
    const existing = this.commands.get(commandId);
    if (!existing) return false;
    this.commands.set(commandId, { ...existing, approvedHash, updatedMs: this.now() });
    await this.persist();
    return true;
  }

  async delete(commandId: string): Promise<boolean> {
    if (!this.commands.delete(commandId)) return false;
    await this.persist();
    return true;
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const payload = JSON.stringify({ version: 1, commands: this.list() }, null, 2);
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    await writeFile(tmp, payload, 'utf8');
    await rename(tmp, this.filePath);
  }
}
