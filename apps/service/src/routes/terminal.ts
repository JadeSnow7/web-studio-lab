import type { RouteHandlers } from './types';

export const terminalRoutes = {
  'terminal.get': (request, { environments }) => environments.terminalSnapshot(environments.identity(request.resourceId)),
  'terminal.open': async (request, { environments, requireReady }, { checkAdmission }) => {
    const identity = environments.identity(request.payload.resourceId);
    if (identity.environmentId === 'sandbox') await requireReady();
    checkAdmission();
    return await environments.openTerminal(identity, request.payload.cols, request.payload.rows);
  },
  'terminal.write': (request, { terminalFor }) => {
    terminalFor(request.payload.resourceId).write(request.payload.sessionId, request.payload.data);
    return null;
  },
  'terminal.resize': (request, { terminalFor }) => {
    terminalFor(request.payload.resourceId).resize(request.payload.sessionId, request.payload.cols, request.payload.rows);
    return null;
  },
  'terminal.close': async (request, { terminalFor }) => await terminalFor(request.payload.resourceId).close(request.payload.sessionId),
} satisfies RouteHandlers<'terminal.get' | 'terminal.open' | 'terminal.write' | 'terminal.resize' | 'terminal.close'>;
