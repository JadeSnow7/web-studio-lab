import type { RouteHandlers } from './types';

export const observationRoutes = {
  'observation.read': async (request, { observations, environments }) => {
    if (observations.has(request.payload.requestId)) throw new Error('Duplicate observation request');
    const controller = new AbortController();
    observations.set(request.payload.requestId, controller);
    try {
      return await environments.observe(request.payload, controller.signal);
    } finally {
      observations.delete(request.payload.requestId);
    }
  },
  'observation.cancel': (request, { observations }) => {
    observations.get(request.payload.requestId)?.abort();
    return null;
  },
  'observation.reply': (request, { observationCalls }) => {
    const call = observationCalls.get(request.payload.callId);
    if (call) {
      observationCalls.delete(request.payload.callId);
      call.signal.removeEventListener('abort', call.abort);
      call.resolve(request.payload.result);
    }
    return null;
  },
} satisfies RouteHandlers<'observation.read' | 'observation.cancel' | 'observation.reply'>;
