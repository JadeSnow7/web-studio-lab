import { z } from 'zod';

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const taskSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.literal('VS001'),
  runId: z.uuid(),
  instruction: z.literal('Change only src/App.tsx so the unique visible [data-testid="greeting"] reads exactly Hello Web Studio. Use one real Agent harness session.'),
  allowedPaths: z.tuple([z.literal('src/App.tsx')]).readonly(),
  initialText: z.literal('Hello baseline'),
  expectedText: z.literal('Hello Web Studio'),
  selector: z.literal('[data-testid="greeting"]'),
}).strict().readonly();
export type Task = z.infer<typeof taskSchema>;

const binding = {
  runId: z.uuid(), taskSha256: sha256Schema, seq: z.number().int().positive(), at: z.iso.datetime(),
};
const command = z.array(z.string().min(1)).min(1);
export const identitySchema = z.object({
  pid: z.number().int().positive(), webContentsId: z.number().int().positive(),
  targetId: z.string().min(1), previewUrl: z.url(), cdpEndpoint: z.url(),
}).strict();
export type AppIdentity = z.infer<typeof identitySchema>;
export const productEventSchema = z.discriminatedUnion('type', [
  z.object({ ...binding, type: z.literal('harness.started'), pid: z.number().int().positive(),
    sessionId: z.string().min(1), harness: z.string().min(1), version: z.string().min(1),
    model: z.string().min(1), command }).strict(),
  z.object({ ...binding, type: z.literal('harness.exited'), pid: z.number().int().positive(),
    sessionId: z.string().min(1), exitCode: z.number().int() }).strict(),
  z.object({ ...binding, type: z.literal('app.started'), pid: z.number().int().positive(), command }).strict(),
  z.object({ ...binding, type: z.literal('app.ready'), identity: identitySchema }).strict(),
]);
export type ProductEvent = z.infer<typeof productEventSchema>;
export const rawLogSchema = z.object({
  runId: z.uuid(), taskSha256: sha256Schema, at: z.iso.datetime(),
  source: z.enum(['harness', 'app']), pid: z.number().int().positive(),
  sessionId: z.string().min(1).optional(), stream: z.enum(['stdout', 'stderr']), text: z.string().min(1),
}).strict();
export type RawLog = z.infer<typeof rawLogSchema>;

export interface AdapterContext {
  workspaceDir: string;
  taskSha256: string;
  signal: AbortSignal;
  registerCleanup(cleanup: () => Promise<void>): void;
  emit(event: ProductEvent): void;
  log(entry: RawLog): void;
}
export interface StartedApplication extends AppIdentity { stop(): Promise<void> }
// The adapter owns resources from allocation onward, including cleanup on signal.abort
// before executeTask returns. Register idempotent cleanup immediately upon resource
// creation. Return the about:blank target; the baseline subscribes then navigates.
// stop and registered cleanup must release only processes belonging to this run.
export type ExecuteTask = (task: Task, context: AdapterContext) => Promise<StartedApplication>;
export interface ProductAdapter { executeTask: ExecuteTask }

export const observationSchema = z.object({
  url: z.url(), runId: z.string().nullable(), readyState: z.enum(['loading', 'interactive', 'complete']),
  matches: z.array(z.object({ text: z.string(), visible: z.boolean() }).strict()),
}).strict();
export type Observation = z.infer<typeof observationSchema>;
