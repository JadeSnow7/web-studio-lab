import { z } from 'zod';
const utf8Bytes = (value: string) => {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
  }
  return bytes;
};

export const ResourceIdentitySchema = z.object({
  workspaceId: z.string().min(1).max(200),
  environmentId: z.string().min(1).max(200),
  resourceId: z.string().min(1).max(200),
  kind: z.enum(['browser', 'terminal', 'file']),
});
export type ResourceIdentity = z.infer<typeof ResourceIdentitySchema>;
export const ResourceInstanceIdentitySchema = ResourceIdentitySchema.extend({
  instanceId: z.string().min(1).max(200),
  instanceGeneration: z.number().int().nonnegative(),
}).strict();
export type ResourceInstanceIdentity = z.infer<typeof ResourceInstanceIdentitySchema>;

export const ObservationSchema = z
  .object({
    resource: ResourceInstanceIdentitySchema,
    generation: z.string().min(1).max(200),
    revision: z.object({ value: z.string(), strength: z.enum(['content-hash', 'sequence', 'document', 'best-effort']) }),
    snapshotId: z.string().uuid(),
    capturedAt: z.string().datetime(),
    startedAt: z.string().datetime().optional(),
    source: z.string().min(1).max(80),
    representation: z.string().min(1).max(80),
    coverage: z.object({
      status: z.enum(['complete', 'partial', 'unknown']),
      range: z.unknown().optional(),
      reasons: z.array(z.string().max(1000)).max(30).optional(),
    }),
    data: z.record(z.string(), z.unknown()),
    nextCursor: z.string().optional(),
    evidenceRef: z.string().max(200).optional(),
  })
  .strict();
export type Observation = z.infer<typeof ObservationSchema>;
export const ObservationErrorSchema = z
  .object({
    error: z.enum([
      'unsupported',
      'unauthorized',
      'unavailable',
      'not_found',
      'stale_cursor',
      'stale_ref',
      'gap',
      'invalid_request',
      'timeout',
      'unstable',
      'cancelled',
      'budget_exceeded',
    ]),
    message: z.string(),
    details: z.unknown().optional(),
  })
  .strict();
export type ObservationError = z.infer<typeof ObservationErrorSchema>;
export const ObservationRequestSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    workspaceId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200).nullable(),
    runId: z.string().min(1).max(200).nullable(),
    target: ResourceInstanceIdentitySchema.nullable(),
    tool: z.enum([
      'workspace.list_sources',
      'browser.snapshot',
      'browser.query',
      'browser.screenshot',
      'browser.read_events',
      'terminal.read_screen',
      'terminal.read_output',
      'terminal.read_command',
      'files.list',
      'files.search',
      'files.read',
    ]),
    args: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .refine((request) => !request.target || request.target.workspaceId === request.workspaceId, {
    message: 'Observation target belongs to another workspace',
  })
  .refine((request) => JSON.stringify(request.args).length <= 65536, { message: 'Observation arguments exceed budget' });
export type ObservationRequest = z.infer<typeof ObservationRequestSchema>;
export const ObservationResultSchema = z.union([ObservationSchema, ObservationErrorSchema]);
export type ObservationResult = z.infer<typeof ObservationResultSchema>;

/** A registry listing describes configured resources; it is not a fabricated capture. */
export const ObservationSourcesSchema = z
  .object({
    kind: z.literal('sources'),
    workspaceId: z.string().min(1).max(200),
    sources: z
      .array(
        z
          .object({
            resource: ResourceIdentitySchema.extend({ environmentId: z.string().min(1).max(200).nullable() }).strict(),
            instance: ResourceInstanceIdentitySchema.nullable(),
            title: z.string().max(200),
            capabilities: z.array(z.string().max(80)).max(20),
            state: z.enum(['live', 'closed', 'unavailable']),
            reason: z.string().max(2000).nullable(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();
export type ObservationSources = z.infer<typeof ObservationSourcesSchema>;
export const WorkspaceObservationResultSchema = z.union([ObservationSourcesSchema, ObservationResultSchema]);
export type WorkspaceObservationResult = z.infer<typeof WorkspaceObservationResultSchema>;

export const WorkbenchObservationInputSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    workspaceId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200).nullable(),
    runId: z.string().min(1).max(200).nullable(),
    resourceId: z.string().min(1).max(200).nullable(),
    tool: ObservationRequestSchema.shape.tool,
    args: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .refine((input) => utf8Bytes(JSON.stringify(input.args)) <= 16384, { message: 'Observation arguments exceed budget' });
export type WorkbenchObservationInput = z.infer<typeof WorkbenchObservationInputSchema>;
export const ObservationTurnScopeSchema = z
  .object({
    workspaceId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    runId: z.string().min(1).max(200),
    sources: ObservationSourcesSchema.shape.sources,
  })
  .strict();
export type ObservationTurnScope = z.infer<typeof ObservationTurnScopeSchema>;
export const ObservationRecordSchema = z
  .object({
    request: ObservationRequestSchema,
    state: z.enum(['pending', 'completed', 'cancelled', 'failed']),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().nullable(),
    result: WorkspaceObservationResultSchema.nullable(),
    evidenceRef: z.string().max(200).nullable(),
  })
  .strict();
export type ObservationRecord = z.infer<typeof ObservationRecordSchema>;

/** Validate payloads at the provider boundary in addition to the common envelope. */
export const ObservationDataSchemas = {
  accessibility: z
    .object({
      target: z.object({ webContentsId: z.number().int() }),
      documentGeneration: z.number().int(),
      url: z.string(),
      title: z.string(),
      elements: z
        .array(z.object({ ref: z.string().optional(), role: z.string().optional(), name: z.string().optional() }).passthrough())
        .max(100),
    })
    .passthrough(),
  'dom-element': z.object({ ref: z.string(), attributes: z.record(z.string(), z.string()) }).passthrough(),
  screenshot: z
    .object({ target: z.number().int(), width: z.number().int(), height: z.number().int(), dataUrl: z.string().max(1000000) })
    .passthrough(),
  'runtime-events': z
    .object({
      events: z
        .array(z.object({ sequence: z.number().int(), capturedAt: z.string().datetime(), type: z.string(), data: z.unknown() }))
        .max(500),
    })
    .passthrough(),
  terminal_screen: z
    .object({
      sessionId: z.string(),
      buffer: z.enum(['normal', 'alternate']),
      processedSeq: z.number().int(),
      receivedSeq: z.number().int(),
      lines: z.array(z.object({ line: z.number().int(), text: z.string(), wrapped: z.boolean() })).max(300),
    })
    .passthrough(),
  terminal_output: z
    .object({
      sessionId: z.string(),
      records: z.array(z.object({ seq: z.number().int(), data: z.string(), capturedAt: z.string().datetime() }).passthrough()),
      stream: z.literal('pty_combined'),
    })
    .passthrough(),
  terminal_commands: z
    .object({
      sessionId: z.string(),
      commands: z
        .array(
          z
            .object({
              commandId: z.string(),
              command: z.string(),
              status: z.enum(['running', 'completed', 'unknown']),
              exitCode: z.number().nullable(),
            })
            .passthrough(),
        )
        .max(100),
    })
    .passthrough(),
};
export function validateObservationData(observation: Observation): Observation {
  const browserSources = ['accessibility', 'dom-element', 'screenshot', 'runtime-events'];
  const terminalSources = ['terminal_screen', 'terminal_output', 'terminal_commands'];
  const fileSources = ['disk', 'editor', 'sftp', 'disk-search', 'sftp-search'];
  const allowed =
    observation.resource.kind === 'browser' ? browserSources : observation.resource.kind === 'terminal' ? terminalSources : fileSources;
  if (!allowed.includes(observation.source)) throw new Error('Observation source does not match resource kind');
  const schema = ObservationDataSchemas[observation.source as keyof typeof ObservationDataSchemas];
  if (schema) schema.parse(observation.data);
  else if (observation.resource.kind === 'file') {
    z.union([
      z
        .object({
          text: z.string().max(65536),
          encoding: z.literal('utf-8'),
          contentSha256: z.string(),
          hashScope: z.literal('whole_file'),
        })
        .passthrough(),
      z.object({ entries: z.array(z.object({ name: z.string(), kind: z.string() })).max(500) }).passthrough(),
      z.object({ matches: z.array(z.unknown()).max(100) }).passthrough(),
      z.object({ mediaType: z.string(), imageInputRequired: z.literal(true) }).passthrough(),
    ]).parse(observation.data);
  } else throw new Error('Unsupported observation payload source');
  if (JSON.stringify(observation).length > 1100000) throw new Error('Observation exceeds total result budget');
  return observation;
}

/** Lossy invalidation hint, never proof of unchanged contents or a recursive watch. */
export const FileInvalidationHintSchema = z
  .object({
    workspaceId: z.string().min(1).max(200),
    environmentId: z.string().min(1).max(200),
    resourceId: z.string().min(1).max(200),
    kind: z.literal('file'),
    instanceId: z.string().min(1).max(200),
    instanceGeneration: z.number().int().nonnegative(),
    generation: z.string().min(1).max(200),
    watchGeneration: z.number().int().nonnegative(),
    sequence: z.number().int().nonnegative(),
    capturedAt: z.string().datetime(),
    change: z.enum(['change', 'rename', 'delete', 'unknown', 'root_replaced', 'closed']),
    coverage: z.object({ scope: z.literal('observed-directories'), recursive: z.literal(false), lossy: z.literal(true) }).strict(),
  })
  .strict();
export type FileInvalidationHint = z.infer<typeof FileInvalidationHintSchema>;
