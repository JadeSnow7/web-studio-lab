import type { RouteHandlers } from './types';

export const environmentRoutes = {
  'environments.list': (_request, { environments }) => environments.list(),
  'resource.register': async (request, { environments }) => {
    await environments.register(request.payload);
    return null;
  },
  'resource.release': async (request, { environments }) => {
    await environments.release(request.payload);
    return null;
  },
} satisfies RouteHandlers<'environments.list' | 'resource.register' | 'resource.release'>;
