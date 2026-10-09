import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';
import { openDatabase, migrateDatabase } from './db.js';
import { createApp, identitySchema } from './app.js';

const port = z.coerce
  .number()
  .int()
  .min(0)
  .max(65535)
  .parse(process.env.PORT ?? '3000');
const identity = identitySchema.parse({
  workspaceId: process.env.WSL_WORKSPACE_ID ?? 'local-workspace',
  environmentId: process.env.WSL_ENVIRONMENT_ID ?? 'local-environment',
  projectId: process.env.WSL_PROJECT_ID ?? 'local-project',
  appInstanceId: process.env.WSL_APP_INSTANCE_ID ?? 'local-app',
});
const database = await openDatabase(process.env.WSL_DATA_DIR ?? '.data/pglite');
try {
  await migrateDatabase(database);
} catch (error) {
  await database.client.close();
  throw error;
}
const app = createApp(database, identity, process.env.WSL_DEV_SESSIONS === '1');
app.use('/*', serveStatic({ root: './dist/client' }));
app.get('*', serveStatic({ path: './dist/client/index.html' }));
const server = serve({ fetch: app.fetch, hostname: process.env.HOST ?? '0.0.0.0', port }, (info) => {
  console.log(JSON.stringify({ event: 'app-ready', port: info.port, identity }));
});
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => {
    console.error('Graceful shutdown timed out');
    process.exit(1);
  }, 8000);
  server.close((error) => {
    void database.client
      .close()
      .then(() => {
        clearTimeout(deadline);
        process.exit(error ? 1 : 0);
      })
      .catch((cause: unknown) => {
        console.error(cause);
        process.exit(1);
      });
  });
  if ('closeIdleConnections' in server) server.closeIdleConnections();
}
server.on('error', (error) => {
  console.error(error);
  void database.client.close().finally(() => process.exit(1));
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
