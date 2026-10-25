import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

/** A real local HTTP origin; it replaces no Electron/Chromium networking API. */
export async function fullBrowserServer() {
  const requests: { method: string; path: string; body: string; cookie: string }[] = [];
  const disconnects: { code: string; syscall: string | undefined; phase: string; aborted: boolean }[] = [];
  const failures: Error[] = [];
  const recorded = new WeakSet<Error>();
  const record = (error: unknown, phase: string, aborted = false) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (recorded.has(failure)) return;
    recorded.add(failure);
    const { code, syscall } = failure as NodeJS.ErrnoException;
    // Only transport errors that identify a broken peer, or an aborted request read, are expected during browser shutdown.
    if ((code === 'EPIPE' && syscall === 'write') || (code === 'ECONNRESET' && (syscall === 'read' || aborted)))
      disconnects.push({ code, syscall, phase, aborted });
    else failures.push(failure);
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
    } catch (error) {
      record(error, 'request-body', req.aborted);
      res.destroy();
      return;
    }
    const body = Buffer.concat(chunks).toString();
    const url = new URL(req.url!, 'http://localhost');
    requests.push({ method: req.method!, path: url.pathname + url.search, body, cookie: req.headers.cookie ?? '' });
    if (url.pathname === '/login' && req.method === 'POST') {
      res.writeHead(303, { 'set-cookie': 'fixture_login=present; Max-Age=3600; HttpOnly; SameSite=Lax; Path=/', location: '/account' });
      res.end();
      return;
    }
    if (url.pathname === '/disconnect') {
      req.socket.destroy();
      return;
    }
    if (url.pathname === '/service-worker.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(
        "addEventListener('install',()=>self.skipWaiting());addEventListener('activate',e=>e.waitUntil(clients.claim()));addEventListener('message',e=>e.waitUntil(fetch('/api').then(r=>r.json()).then(v=>e.source.postMessage(v.message))));",
      );
      return;
    }
    if (url.pathname === '/api') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: 'fetch works', authenticated: req.headers.cookie?.includes('fixture_login=present') ?? false }));
      return;
    }
    if (url.pathname === '/worker.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end("fetch('/api').then(r=>r.json()).then(value=>postMessage(value.message))");
      return;
    }
    if (url.pathname === '/style.css') {
      res.setHeader('content-type', 'text/css');
      res.end('#styled{color:rgb(18, 52, 86)}');
      return;
    }
    if (url.pathname === '/image.svg') {
      res.setHeader('content-type', 'image/svg+xml');
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>');
      return;
    }
    if (url.pathname === '/frame') {
      res.setHeader('content-type', 'text/html');
      res.end('<p id="frame-body">frame works</p><script>window.frameStudio=typeof studio</script>');
      return;
    }
    if (url.pathname === '/popup') {
      res.setHeader('content-type', 'text/html');
      res.end(
        `<title>Misleading title</title><button id="complete" onclick="localStorage.setItem('popup','shared');opener.postMessage('popup-login-complete',location.origin);window.close()">Complete sign in</button>`,
      );
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.setHeader(
      'content-security-policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self'; connect-src 'self' ws://127.0.0.1:*; frame-src 'self'",
    );
    res.end(`<!doctype html><html><head><title>Full browser fixture</title><link rel="stylesheet" href="/style.css"></head><body>
<h1 id="styled">Full browser fixture</h1><p id="route">${url.pathname === '/search' ? 'Search: ' + url.searchParams.get('q') : url.pathname === '/account' ? 'Account page' : 'Home page'}</p>
<img id="image" src="/image.svg"><iframe id="frame" src="/frame"></iframe><iframe id="srcdoc" srcdoc="<p>srcdoc works</p>"></iframe>
<form action="/search"><input name="q" id="query"><button id="search">Search</button></form>
<form action="/login" method="post"><input name="username" value="fixture-user"><input name="password" type="password" value="DO-NOT-CAPTURE-PASSWORD"><textarea>DO-NOT-CAPTURE-TEXTAREA</textarea><button id="login">Sign in</button></form>
<div contenteditable="true">DO-NOT-CAPTURE-EDITABLE</div><p hidden>DO-NOT-CAPTURE-HIDDEN</p>
<button id="popup" onclick="window.loginPopup=window.open('/popup','login','width=520,height=420,frame=no,nodeIntegration=yes,webviewTag=yes')">Popup sign in</button>
<button id="blank-popup" onclick="const child=window.open('about:blank','blankLogin');child.location='/popup'">Blank popup</button>
<a id="external" href="custom-browser-test://forbidden">External protocol</a><a id="file" href="file:///etc/passwd">File protocol</a><a id="target" target="_blank" href="/next">New window</a>
<button id="spa" onclick="history.pushState({},'', '#spa');document.querySelector('#route').textContent='SPA works'">SPA</button>
<p id="service-worker">loading</p><p id="fetch">loading</p><p id="worker">loading</p><p id="websocket">loading</p><p id="message"></p><p id="storage"></p>
<script>
window.fixtureExecuted=true;
navigator.serviceWorker.addEventListener('message',e=>document.querySelector('#service-worker').textContent=e.data);
navigator.serviceWorker.register('/service-worker.js').then(()=>navigator.serviceWorker.ready).then(r=>r.active.postMessage('fetch'));
fetch('/api').then(r=>r.json()).then(v=>document.querySelector('#fetch').textContent=v.message+(v.authenticated?' authenticated':''));
new Worker('/worker.js').onmessage=e=>document.querySelector('#worker').textContent=e.data;
const socket=new WebSocket('ws://'+location.host+'/ws');socket.onmessage=e=>document.querySelector('#websocket').textContent=e.data;
addEventListener('message',e=>{if(e.origin===location.origin)document.querySelector('#message').textContent=e.data});
document.querySelector('#storage').textContent=localStorage.getItem('login')||'empty';
document.querySelector('#login').addEventListener('click',()=>localStorage.setItem('login','persistent-login'));
</script></body></html>`);
  });
  server.on('connection', (socket) => socket.on('error', (error) => record(error, 'socket')));
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1')
      .update(req.headers['sec-websocket-key']! + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n',
    );
    const payload = Buffer.from('websocket works');
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    socket.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address missing');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    disconnects,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, failures.map((error) => error.message).join('; '));
    },
  };
}
