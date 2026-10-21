import { z } from 'zod';

export const MOTA_PLAY_SCOPE = 'app.mota.play';
export const MOTA_MAP_WRITE_SCOPE = 'app.mota.map.write';

const id = z.string().min(1).max(200);
const generation = z.number().int().nonnegative();
const coordinate = z.number().int().min(0).max(63);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const floor = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/);
const value = z.number().finite().min(-1e15).max(1e15);
/** Frozen by Main from the active run and its owned Browser; never supplied by the model. */
export const MotaTaskBindingSchema = z
  .object({
    workspaceId: id,
    environmentId: z.literal('sandbox'),
    projectId: id,
    appInstanceId: id,
    runId: id,
    sessionId: id,
    resourceId: id,
    browserInstanceId: id,
    browserGeneration: generation,
    webContentsId: z.number().int().positive(),
    documentGeneration: generation,
  })
  .strict();
export type MotaTaskBinding = z.infer<typeof MotaTaskBindingSchema>;

export const MotaActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tile'), floorId: floor, x: coordinate, y: coordinate }).strict(),
  z.object({ type: z.literal('continue') }).strict(),
  z.object({ type: z.literal('newGame') }).strict(),
  z.object({ type: z.literal('key'), key: z.enum(['Enter', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) }).strict(),
]);
export type MotaAction = z.infer<typeof MotaActionSchema>;
const rect = z.object({ x: value, y: value, width: z.number().positive().max(100000), height: z.number().positive().max(100000) }).strict();
export const MotaStateSchema = z
  .object({
    appInstanceId: id,
    documentGeneration: generation,
    played: z.boolean(),
    floorId: floor.nullable(),
    hero: z
      .object({
        x: coordinate,
        y: coordinate,
        hp: value,
        atk: value,
        def: value,
        money: value,
        coin: value,
        keys: z.object({ yellow: value, blue: value, red: value }).strict(),
      })
      .strict()
      .nullable(),
    moving: z.boolean(),
    locked: z.boolean(),
    event: z.object({ id: z.string().max(80).nullable(), type: z.string().max(80).nullable() }).strict(),
    dialogue: z
      .object({ text: z.string().max(2000), canContinue: z.boolean() })
      .strict()
      .nullable(),
    map: z
      .object({
        width: z.number().int().min(1).max(64),
        height: z.number().int().min(1).max(64),
        blocks: z
          .array(
            z
              .object({
                x: coordinate,
                y: coordinate,
                id: z.number().int().min(0).max(100000),
                eventId: z.string().max(80).nullable(),
                disabled: z.boolean(),
              })
              .strict(),
          )
          .max(1024),
        truncated: z.boolean(),
      })
      .strict()
      .nullable(),
    canvas: z
      .object({
        rect,
        viewport: z.object({ width: z.number().positive().max(100000), height: z.number().positive().max(100000) }).strict(),
        logicalWidth: z.number().positive().max(2048),
        logicalHeight: z.number().positive().max(2048),
        offsetX: z.number().nonnegative().max(2048),
        offsetY: z.number().nonnegative().max(2048),
        scale: z.number().positive().max(16),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type MotaState = z.infer<typeof MotaStateSchema>;

export const MotaMapReadSchema = z
  .object({
    floorId: z.literal('MT1'),
    sha256,
    width: z.number().int().min(1).max(64),
    height: z.number().int().min(1).max(64),
    map: z
      .array(z.array(z.number().int().min(0).max(100000)).min(1).max(64))
      .min(1)
      .max(64),
  })
  .strict()
  .refine((data) => data.map.length === data.height && data.map.every((row) => row.length === data.width), 'map dimensions differ');
export type MotaMapRead = z.infer<typeof MotaMapReadSchema>;
export const MotaMapSetInputSchema = z.object({ operationId: z.uuid(), expectedSha256: sha256, x: coordinate, y: coordinate }).strict();
export const MotaMapSetReceiptSchema = z
  .object({
    operationId: z.uuid(),
    floorId: z.literal('MT1'),
    beforeSha256: sha256,
    afterSha256: sha256,
    change: z.object({ x: coordinate, y: coordinate, before: z.literal(0), after: z.literal(53) }).strict(),
  })
  .strict();
export type MotaMapSetReceipt = z.infer<typeof MotaMapSetReceiptSchema>;
export const MotaOperationReadSchema = z
  .object({ operationId: z.uuid(), status: z.enum(['unknown', 'completed']), receipt: MotaMapSetReceiptSchema.nullable() })
  .strict()
  .refine(
    (data) => (data.status === 'unknown' ? data.receipt === null : data.receipt?.operationId === data.operationId),
    'operation receipt mismatch',
  );
const base = { type: z.literal('mota-control'), requestId: z.uuid(), binding: MotaTaskBindingSchema };
export const MotaControlRequestSchema = z.discriminatedUnion('method', [
  z.object({ ...base, method: z.literal('acquire'), input: z.object({}).strict() }).strict(),
  z.object({ ...base, method: z.literal('release'), input: z.object({}).strict() }).strict(),
  z.object({ ...base, method: z.literal('map.read'), input: z.object({}).strict() }).strict(),
  z.object({ ...base, method: z.literal('map.set'), input: MotaMapSetInputSchema }).strict(),
  z.object({ ...base, method: z.literal('operation.read'), input: z.object({ operationId: z.uuid() }).strict() }).strict(),
]);
export type MotaControlRequest = z.infer<typeof MotaControlRequestSchema>;
const response = { type: z.literal('mota-control-result'), requestId: z.uuid(), binding: MotaTaskBindingSchema };
export const MotaControlErrorCodeSchema = z.enum([
  'busy',
  'stale_source',
  'invalid_cell',
  'stale_instance',
  'lease_revoked',
  'owner_unknown',
  'operation_conflict',
  'budget_exceeded',
  'unsupported',
  'cancelled',
]);
export const MotaControlResponseSchema = z.union([
  ...(['acquire', 'release'] as const).map((method) =>
    z
      .object({ ...response, method: z.literal(method), ok: z.literal(true), data: z.object({ settled: z.literal(true) }).strict() })
      .strict(),
  ),
  z.object({ ...response, method: z.literal('map.read'), ok: z.literal(true), data: MotaMapReadSchema }).strict(),
  z.object({ ...response, method: z.literal('map.set'), ok: z.literal(true), data: MotaMapSetReceiptSchema }).strict(),
  z.object({ ...response, method: z.literal('operation.read'), ok: z.literal(true), data: MotaOperationReadSchema }).strict(),
  z
    .object({
      ...response,
      method: z.enum(['acquire', 'release', 'map.read', 'map.set', 'operation.read']),
      ok: z.literal(false),
      error: z.object({ code: MotaControlErrorCodeSchema, message: z.string().min(1).max(1000) }).strict(),
    })
    .strict(),
]);
export type MotaControlResponse = z.infer<typeof MotaControlResponseSchema>;
