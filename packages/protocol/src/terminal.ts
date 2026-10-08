import { z } from 'zod';

const Columns = z.number().int().min(2).max(500);
const Rows = z.number().int().min(1).max(300);
export const TerminalOpenSchema = z.object({ cols: Columns, rows: Rows, resourceId: z.string().min(1).max(200) });
export const TerminalTargetSchema = z.object({ sessionId: z.string().min(1), resourceId: z.string().min(1).max(200) });
const utf8Bytes = (value: string) => {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
  }
  return bytes;
};
export const TerminalWriteSchema = TerminalTargetSchema.extend({
  data: z
    .string()
    .min(1)
    .max(65536)
    .refine((value) => utf8Bytes(value) <= 65536, 'Terminal input exceeds UTF-8 byte budget'),
});
export const TerminalResizeSchema = TerminalTargetSchema.extend({ cols: Columns, rows: Rows });
export const TerminalSnapshotSchema = z.object({
  seq: z.number().int().nonnegative(),
  sessionId: z.string().nullable(),
  sandbox: z.string().nullable(),
  cwd: z.string().nullable(),
  state: z.enum(['idle', 'starting', 'running', 'closing', 'closed', 'failed']),
  output: z.string().max(262144),
  outputOffset: z.number().int().nonnegative().optional(),
  cleanupPending: z.boolean(),
  error: z.string().nullable(),
});
export type TerminalSnapshot = z.infer<typeof TerminalSnapshotSchema>;
