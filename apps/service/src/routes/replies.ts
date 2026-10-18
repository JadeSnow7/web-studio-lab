import type { RouteHandlers } from './types';

export const replyRoutes = {
  'app.reply': (request, { appCalls }) => {
    const call = appCalls.get(request.payload.callId);
    if (call) {
      appCalls.delete(request.payload.callId);
      call.signal.removeEventListener('abort', call.abort);
      call.resolve(request.payload.result);
    }
    return null;
  },
  'research.reply': (request, { researchCalls, validateResearchReply }) => {
    const pending = researchCalls.get(request.payload.callId);
    if (pending) {
      const reply = validateResearchReply(pending.call, request.payload);
      researchCalls.delete(request.payload.callId);
      pending.signal.removeEventListener('abort', pending.abort);
      pending.resolve(reply);
    }
    return null;
  },
} satisfies RouteHandlers<'app.reply' | 'research.reply'>;
