import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.WIKI_PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WIKI_PORT must be 1–65535');
const allowed = new Set(['index.html', 'styles.css', 'app.js', 'data.js', 'sources.js', 'snapshot-manifest.json']);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
createServer(async (request, response) => {
  let name;
  try {
    name = new URL(request.url, 'http://127.0.0.1').pathname.slice(1) || 'index.html';
  } catch {
    response.writeHead(400);
    response.end('Bad request');
    return;
  }
  if (!['GET', 'HEAD'].includes(request.method) || !allowed.has(name)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  try {
    const content = await readFile(resolve(root, name));
    response.writeHead(200, { 'Content-Type': types[extname(name)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    console.error(error);
    response.writeHead(500);
    response.end('Unable to read prototype asset');
  }
}).listen(port, '127.0.0.1', () => console.log(`Code Wiki prototype: http://127.0.0.1:${port}`));
