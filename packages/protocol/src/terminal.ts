import { z } from 'zod';

const Columns = z.number().int().min(2).max(500);
const Rows = z.number().int().min(1).max(300);
export const TerminalOpenSchema = z.object({ cols: Columns, rows: Rows });
export const TerminalTargetSchema = z.object({ sessionId: z.string().min(1) });
export const TerminalWriteSchema = TerminalTargetSchema.extend({ data: z.string().min(1).max(65536) });
export const TerminalResizeSchema = TerminalTargetSchema.extend({ cols: Columns, rows: Rows });
export const TerminalSnapshotSchema = z.object({
  seq: z.number().int().nonnegative(),
  sessionId: z.string().nullable(),
  sandbox: z.string().nullable(),
  cwd: z.string().nullable(),
  state: z.enum(['idle', 'starting', 'running', 'closing', 'closed', 'failed']),
  output: z.string().max(262144),
  cleanupPending: z.boolean(),
  error: z.string().nullable(),
});
export type TerminalSnapshot = z.infer<typeof TerminalSnapshotSchema>;
