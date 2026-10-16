import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  MAX_NATIVE_SEARCH_BYTES,
  MAX_NATIVE_SEARCH_RECORDS,
  ResearchNativeSearchRecordSchema,
  ResearchReplySchema,
  type ChatConversation,
  type ResearchCall,
  type ResearchNativeSearchRecord,
} from '@wsl/protocol';

/** Only provider-emitted item fields are candidates; assistant prose never enters this audit. */
export function recordNativeSearch(
  conversation: ChatConversation,
  eventType: string,
  item: { id: string; type: string; query?: unknown; status?: string },
  turnId: string,
): void {
  const known = item.type === 'web_search' && typeof item.query === 'string';
  const record: ResearchNativeSearchRecord = ResearchNativeSearchRecordSchema.parse({
    itemId: item.id.slice(0, 200),
    turnId,
    status: ['failed', 'error'].includes(item.status ?? '') ? 'failed' : eventType === 'item.completed' ? 'completed' : 'in_progress',
    observedAt: new Date().toISOString(),
    ...(typeof item.query === 'string' ? { query: item.query.slice(0, 4000) } : {}),
    schemaUnsupported: !known,
    truncated: item.id.length > 200 || (typeof item.query === 'string' && item.query.length > 4000),
  });
  const records = (conversation.nativeSearches ??= []);
  const index = records.findIndex((entry) => entry.itemId === record.itemId && entry.turnId === turnId);
  if (index < 0) records.push(record);
  else records[index] = record;
  while (records.length > MAX_NATIVE_SEARCH_RECORDS || Buffer.byteLength(JSON.stringify(records), 'utf8') > MAX_NATIVE_SEARCH_BYTES) {
    records.shift();
    conversation.nativeSearchesTruncated = true;
  }
  if (record.truncated) conversation.nativeSearchesTruncated = true;
}

/** A callback result cannot change the call identity, selected capture or frozen text. */
export function validateResearchReply(call: ResearchCall, input: unknown) {
  const reply = ResearchReplySchema.parse(input);
  if (reply.callId !== call.callId || !isDeepStrictEqual(reply.context, call.context) || reply.result.tool !== call.tool)
    throw new Error('Research reply does not match its owned call');
  if (call.tool === 'research.include' && reply.result.ok && reply.result.tool === 'research.include') {
    const source = reply.result.source;
    if (
      source.captureId !== call.args.captureId ||
      source.contentSha256 !== call.args.contentSha256 ||
      createHash('sha256').update(source.text, 'utf8').digest('hex') !== source.contentSha256
    )
      throw new Error('Research inclusion does not match its frozen capture');
  }
  return reply;
}
