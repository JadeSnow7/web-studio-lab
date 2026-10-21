import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EduVerificationLeaseSchema, type EduVerificationLease } from '@wsl/protocol';
export const ASSESSMENT_PREFIX = 'WSL_EDU_ASSESSMENT_REQUEST:';
export const MAX_ASSESSMENT_FRAME = 1_500_000;
export const MAX_ASSESSMENT_RESULT = 65536;
const uuid = EduVerificationLeaseSchema.shape.sessionId;
const digest = EduVerificationLeaseSchema.shape.sourceSha256;
const requestSchema = EduVerificationLeaseSchema.omit({ expiresAtMs: true })
  .extend({
    requestId: uuid,
    submissionId: uuid,
    audioSha256: digest,
    reference: z
      .string()
      .min(1)
      .max(2000)
      .regex(/^[A-Za-z]+(?:[-'][A-Za-z]+)*$/),
    audioBase64: z.string(),
  })
  .strict();
export type AssessmentRequest = z.infer<typeof requestSchema>;
/** Reject duplicate keys before schema parsing; JSON.parse alone silently overwrites them. */
export function strictJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\],:]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) ?? [];
    const objects: ({ keys: Set<string>; key: boolean } | null)[] = [];
    for (const token of tokens) {
      if (token === '{') objects.push({ keys: new Set(), key: true });
      else if (token === '[') objects.push(null);
      else if (token === '}' || token === ']') objects.pop();
      else if (token === ',') {
        const last = objects.at(-1);
        if (last) last.key = true;
      } else if (token === ':') {
        const last = objects.at(-1);
        if (last) last.key = false;
      } else if (token[0] === '"' && objects.at(-1)?.key) {
        const last = objects.at(-1)!;
        const key = JSON.parse(token) as string;
        if (last.keys.has(key)) throw new Error();
        last.keys.add(key);
        last.key = false;
      }
    }
    return value;
  } catch {
    throw new Error('assessment_invalid_json');
  }
}
export function parseRequest(line: string, lease: EduVerificationLease): AssessmentRequest {
  if (
    !line.startsWith(ASSESSMENT_PREFIX) ||
    !line.endsWith('\n') ||
    line.slice(0, -1).includes('\n') ||
    Buffer.byteLength(line) > MAX_ASSESSMENT_FRAME
  )
    throw new Error('assessment_invalid_frame');
  const request = requestSchema.parse(strictJson(line.slice(ASSESSMENT_PREFIX.length, -1)));
  if (
    request.sessionId !== lease.sessionId ||
    request.sourceSha256 !== lease.sourceSha256 ||
    (['workspaceId', 'environmentId', 'projectId', 'appInstanceId'] as const).some((key) => request.identity[key] !== lease.identity[key])
  )
    throw new Error('assessment_identity_mismatch');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.audioBase64))
    throw new Error('assessment_invalid_audio');
  const wav = Buffer.from(request.audioBase64, 'base64');
  if (createHash('sha256').update(wav).digest('hex') !== request.audioSha256) throw new Error('assessment_audio_mismatch');
  validateWav(wav);
  return request;
}
export function validateWav(wav: Buffer): void {
  if (
    wav.length < 44 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE' ||
    wav.readUInt32LE(4) + 8 !== wav.length
  )
    throw new Error('assessment_invalid_audio');
  let format = false,
    data: number | null = null;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4),
      start = offset + 8,
      end = start + size;
    if (end > wav.length) throw new Error('assessment_invalid_audio');
    const kind = wav.toString('ascii', offset, offset + 4);
    if (kind === 'fmt ') {
      if (
        format ||
        size < 16 ||
        wav.readUInt16LE(start) !== 1 ||
        wav.readUInt16LE(start + 2) !== 1 ||
        wav.readUInt32LE(start + 4) !== 16000 ||
        wav.readUInt32LE(start + 8) !== 32000 ||
        wav.readUInt16LE(start + 12) !== 2 ||
        wav.readUInt16LE(start + 14) !== 16
      )
        throw new Error('assessment_invalid_audio');
      format = true;
    }
    if (kind === 'data') {
      if (data !== null || size % 2) throw new Error('assessment_invalid_audio');
      data = size;
    }
    offset = end + (size % 2);
  }
  if (!format || data === null || data < 6400 || data > 960000) throw new Error('assessment_invalid_audio');
}
const score = z.number().finite().min(0).max(100);
const word = z
  .object({
    word: z.string(),
    error_type: z.enum(['None', 'Omission', 'Insertion', 'Mispronunciation']),
    accuracy_score: score.optional(),
    phonemes: z.array(z.object({ phoneme: z.string(), accuracy_score: score }).strict()).optional(),
  })
  .strict()
  .refine((w) => w.error_type === 'Omission' || w.accuracy_score !== undefined);
const resultSchema = z
  .object({
    provider: z.literal('azure'),
    score,
    accuracy_score: score,
    rejected: z.boolean(),
    transcript: z.string(),
    words: z.array(word).min(1),
    pronunciation_score: score.optional(),
    fluency_score: score.optional(),
    completeness_score: score.optional(),
    prosody_score: score.optional(),
  })
  .strict();
const common = {
  schemaVersion: z.literal(1),
  event: z.literal('edu-assessment-result'),
  sessionId: uuid,
  requestId: uuid,
  audioSha256: digest,
};
const responseSchema = z.discriminatedUnion('ok', [
  z.object({ ...common, ok: z.literal(true), result: resultSchema }).strict(),
  z
    .object({
      ...common,
      ok: z.literal(false),
      error: z
        .object({
          code: z.enum(['invalid_request', 'provider_failed', 'internal_error', 'revoked', 'expired', 'budget_exhausted']),
          message: z.string().max(300),
        })
        .strict(),
    })
    .strict(),
]);
export function parseResponse(raw: Buffer, request: AssessmentRequest): string {
  if (raw.length > MAX_ASSESSMENT_RESULT || raw.at(-1) !== 10 || raw.subarray(0, -1).includes(10))
    throw new Error('assessment_invalid_result_frame');
  const response = responseSchema.parse(strictJson(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
  if (response.sessionId !== request.sessionId || response.requestId !== request.requestId || response.audioSha256 !== request.audioSha256)
    throw new Error('assessment_result_mismatch');
  if (response.ok) {
    const result = response.result;
    // Lexical/miscue normalization is rechecked by the guest's existing Python normalizer.
    if (result.score !== result.accuracy_score) throw new Error('assessment_inconsistent_result');
  } else response.error.message = '发音评估未完成，未授予资格';
  return JSON.stringify(response) + '\n';
}
