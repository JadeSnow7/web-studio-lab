import { z } from 'zod';
import { GuestPageResourceSnapshotSchema } from './resources';

export const GUEST_BROWSER_SANDBOX = 'wsl-sbx-smoke-20261006';
export const GUEST_BROWSER_URL = 'https://docs.docker.com/';
export const MAX_GUEST_BROWSER_FRAME_BYTES = 4 * 1024 * 1024;
export const MAX_GUEST_SCREENSHOT_BYTES = 2 * 1024 * 1024;

// 首轮只开放一个明确批准的站点；这不是任意 URL/CDP/命令接口。
export const GuestBrowserRequestSchema = z
  .object({
    operation: z.literal('capture'),
    url: z.literal(GUEST_BROWSER_URL),
    sandboxName: z.literal(GUEST_BROWSER_SANDBOX),
    captureId: z.uuid(),
  })
  .strict();
const ProcessProofSchema = z
  .object({
    pid: z.number().int().positive(),
    seccomp: z.number().int().nonnegative(),
    seccompFilters: z.number().int().nonnegative(),
    noNewPrivs: z.number().int().nonnegative(),
    pidNamespace: z.string().min(1).max(128),
    userNamespace: z.string().min(1).max(128),
  })
  .strict();
const GuestSchema = z
  .object({
    platform: z.literal('linux'),
    architecture: z.string().min(1).max(32),
    uid: z.number().int().positive(),
    nodeVersion: z.string().max(64),
  })
  .strict();
const LaunchSchema = z
  .object({
    chromiumSandbox: z.literal(true),
    debuggingPipe: z.literal(true),
    noSandboxFlag: z.literal(false),
    browserPid: z.number().int().positive(),
    browserVersion: z.string().min(1).max(128),
    executable: z.string().min(1).max(1024),
    elf: z.literal(true),
  })
  .strict();
const SandboxProofSchema = z
  .object({
    diagnostic: z.object({ namespaceSandbox: z.literal(true), pidNamespaces: z.literal(true), seccompBpf: z.literal(true) }).strict(),
    browser: ProcessProofSchema,
    renderers: z.array(ProcessProofSchema).min(1).max(16),
  })
  .strict()
  .refine(
    (proof) =>
      proof.renderers.every(
        (renderer) =>
          renderer.seccomp === 2 &&
          renderer.seccompFilters > proof.browser.seccompFilters &&
          renderer.noNewPrivs === 1 &&
          renderer.pidNamespace !== proof.browser.pidNamespace,
      ),
    'Chromium renderer 隔离证据不足',
  );
const EvidenceFields = { guest: GuestSchema, launch: LaunchSchema, sandbox: SandboxProofSchema };
const NetworkEntrySchema = z.object({ origin: z.string().max(256), path: z.string().max(256), reason: z.string().max(128) }).strict();
const NetworkSchema = z
  .object({
    totalRequests: z.number().int().nonnegative().max(10000),
    blocked: z.array(NetworkEntrySchema).max(32),
    failed: z.array(NetworkEntrySchema).max(32),
  })
  .strict();
const CleanupSchema = z.object({ browserClosed: z.boolean() }).strict();
export const GuestBrowserResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      protocolVersion: z.literal(1),
      ok: z.literal(true),
      snapshot: GuestPageResourceSnapshotSchema,
      screenshot: z
        .object({
          mimeType: z.literal('image/png'),
          base64: z.string().max(Math.ceil(MAX_GUEST_SCREENSHOT_BYTES / 3) * 4),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          bytes: z.number().int().positive().max(MAX_GUEST_SCREENSHOT_BYTES),
        })
        .strict(),
      evidence: z.object(EvidenceFields).strict(),
      network: NetworkSchema,
      cleanup: CleanupSchema,
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      ok: z.literal(false),
      error: z.object({ code: z.string().regex(/^[A-Z0-9_]{1,64}$/), message: z.string().max(300) }).strict(),
      cleanup: CleanupSchema,
      evidence: z.object(EvidenceFields).partial().strict().optional(),
      network: NetworkSchema.optional(),
    })
    .strict(),
]);
export type GuestBrowserRequest = z.infer<typeof GuestBrowserRequestSchema>;
export type GuestBrowserResult = z.infer<typeof GuestBrowserResultSchema>;
export type GuestBrowserSuccess = Extract<GuestBrowserResult, { ok: true }>;
