#!/usr/bin/env node
// 本地预览服务（非原始导出文件，2026-10-06 为本地打开基线画板而写）。
//
// 原 artifact 的画板都引用 `./support.js`，它不是已发布文件，而是 claude.ai 画布在运行时提供的。
// 本脚本只做两件事：
//   1. 以 ../artifact 为根目录，按原路径提供全部导出文件，不改写任何文件内容；
//   2. 把 `/project/support.js` 映射为 `artifact-type/dc-runtime.js`（Design 类型发布的画板运行时）。
// 这个映射是本地假设，不是原平台行为的复制；渲染结果以 claude.ai 上的原 artifact 为准。
// dc-runtime.js 自带 React 与 ReactDOM，2026-10-06 实测本地预览不发起外部请求；
// 只有页面缺少 React / ReactDOM 时，它才会从 cdn.jsdelivr.net 加载 React 18.3.1（带 SRI 校验）。
//
// 用法：node docs/design/2026-10-06-workbench-v0.3/baseline/tools/serve-local.mjs [端口]
/* global console, process, URL */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../artifact');
const port = Number(process.argv[2] ?? 4173);
const runtime = path.join(root, 'artifact-type/dc-runtime.js');

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

async function boardsIndex() {
  const canvas = JSON.parse(await readFile(path.join(root, 'project/canvas.json'), 'utf8'));
  const rows = canvas.order
    .map((file) => {
      const b = canvas.boards[file];
      const tag = b.is_interactive ? '（可交互）' : '';
      return `<li><a href="/project/${encodeURIComponent(file)}">${b.title}</a> <code>${file}</code>${tag}</li>`;
    })
    .join('\n');
  return `<!doctype html><meta charset="utf-8"><title>${canvas.title} · 本地预览</title>
<body style="font:14px -apple-system,'PingFang SC',sans-serif;margin:32px;line-height:1.8">
<h1>${canvas.title}</h1>
<p>本页由 tools/serve-local.mjs 动态生成，不是原 artifact 的一部分。画板按 canvas.json 的 order 排列。</p>
<ol>${rows}</ol></body>`;
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/' || url.pathname === '/__boards') {
      res.writeHead(200, { 'content-type': types['.html'] });
      res.end(await boardsIndex());
      return;
    }
    let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (url.pathname === '/project/support.js') file = runtime;
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(await readFile(file));
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`基线画板本地预览：http://127.0.0.1:${port}/  （Ctrl+C 结束）`);
});
