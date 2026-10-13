/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, module, process, Buffer, URL, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, console */
'use strict';

// 此文件通过 sbx exec 的可信 node -e 程序运行；输入不能提供代码、命令、路径或浏览器参数。
const fs = require('node:fs');
const crypto = require('node:crypto');
const TARGET = 'https://docs.docker.com/';
const SANDBOX = 'wsl-sbx-smoke-20261006';
const LIMITS = Object.freeze({ input: 1024, text: 65536, response: 2097152, screenshot: 2097152, output: 4194304, runtime: 45000 });
const MESSAGES = Object.freeze({
  INVALID_REQUEST: '请求不符合固定网页采集合同',
  CANCELLED: '宿主连接关闭或取消了采集',
  TIMEOUT: '采集超过时间预算',
  MISSING_PLAYWRIGHT: 'guest 缺少已安装的 Playwright；未下载或安装',
  PLATFORM: '此采集器只接受 Linux guest',
  LAUNCH_FAILED: 'Chromium 启动失败；未降低 sandbox 要求',
  MISSING_CHROMIUM: 'guest 缺少匹配的 Chromium；未下载或安装',
  SANDBOX_UNPROVEN: '无法证明 Chromium renderer 隔离；本次采集失败',
  NETWORK_FAILED: '固定目标网页访问失败',
  RESPONSE_LIMIT: '主文档响应超过字节预算',
  SCREENSHOT_LIMIT: '截图超过字节预算',
  CAPTURE_FAILED: '页面采集失败或身份已改变',
  CLEANUP_FAILED: '所属浏览器进程未确认全部退出',
});
class CaptureError extends Error {
  constructor(code) {
    super(MESSAGES[code]);
    this.code = code;
  }
}
function fail(code) {
  throw new CaptureError(code);
}
function parseRequest(line) {
  if (typeof line !== 'string' || Buffer.byteLength(line) > LIMITS.input) fail('INVALID_REQUEST');
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    fail('INVALID_REQUEST');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'captureId,operation,sandboxName,url' ||
    value.operation !== 'capture' ||
    value.url !== TARGET ||
    value.sandboxName !== SANDBOX ||
    typeof value.captureId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.captureId)
  )
    fail('INVALID_REQUEST');
  return value;
}
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function truncateUtf8(value, limit) {
  let text = '';
  let bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char);
    if (bytes + size > limit) break;
    text += char;
    bytes += size;
  }
  return { text, truncated: text.length < value.length };
}
function safeLocation(raw) {
  try {
    const url = new URL(raw);
    return { origin: url.origin.slice(0, 128), path: url.pathname.slice(0, 256) };
  } catch {
    return { origin: 'invalid', path: '' };
  }
}
function requestDecision({ url, method, mainFrame, navigation, redirected }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalid-url';
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'docs.docker.com' ||
    (parsed.port && parsed.port !== '443') ||
    parsed.username ||
    parsed.password
  )
    return 'outside-fixed-origin';
  if (method !== 'GET') return 'method';
  if (!mainFrame) return 'frame';
  if (redirected) return 'redirect';
  if (navigation && url !== TARGET) return 'navigation';
  return null;
}
// 冷启动时 IPv6 DAD 会改变地址 flags，Chromium 会据此取消已经开始的请求。
// 只观察已知 guest 的内核地址表；不修改地址、路由、DNS 或代理，不保证之后不会再变化。
function inspectIpv6Readiness(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 65536) fail('NETWORK_FAILED');
  const rows = text.trim() ? text.trim().split(/\r?\n/) : [];
  const normalized = [];
  let pending = false;
  let hasGuestInterface = false;
  for (const row of rows) {
    const fields = row.trim().split(/\s+/);
    if (
      fields.length !== 6 ||
      !/^[0-9a-f]{32}$/i.test(fields[0]) ||
      !fields.slice(1, 5).every((field) => /^[0-9a-f]{1,8}$/i.test(field)) ||
      Number.parseInt(fields[2], 16) > 128 ||
      !/^[^\s]{1,64}$/.test(fields[5])
    )
      fail('NETWORK_FAILED');
    const flags = Number.parseInt(fields[4], 16);
    // Linux IFA_F_DADFAILED=0x08，IFA_F_TENTATIVE=0x40；0x82 等其它合法组合保留。
    if (flags & 0x08) fail('NETWORK_FAILED');
    if (flags & 0x40) pending = true;
    if (fields[5] === 'eth0') hasGuestInterface = true;
    normalized.push([...fields.slice(0, 5).map((field) => field.toLowerCase()), fields[5]].join(' '));
  }
  return { pending: pending || !hasGuestInterface, fingerprint: sha256(normalized.sort().join('\n')) };
}
async function waitForNetworkReadiness(step, dependencies = {}, signal) {
  // 依赖注入只供可信离线测试；JSON 请求仍只有固定 capture 合同。
  const read = dependencies.read || (() => fs.readFileSync('/proc/net/if_inet6', 'utf8'));
  const now = dependencies.now || (() => Number(process.hrtime.bigint() / 1000000n));
  const pause =
    dependencies.pause ||
    ((milliseconds) =>
      new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, milliseconds);
        signal?.addEventListener('abort', finish, { once: true });
        if (signal?.aborted) finish();
      }));
  const deadline = now() + 5000;
  let fingerprint = null;
  let stableSince = null;
  while (true) {
    // 外层 step 保留原始 TIMEOUT/CANCELLED，并使取消后的 timer 不继续轮询。
    if (signal?.aborted) await step(Promise.resolve());
    let state;
    try {
      state = inspectIpv6Readiness(read());
    } catch {
      fail('NETWORK_FAILED');
    }
    const at = now();
    if (at >= deadline) fail('NETWORK_FAILED');
    if (state.pending) stableSince = null;
    else if (state.fingerprint !== fingerprint || stableSince === null) stableSince = at;
    else if (at - stableSince >= 200) return;
    fingerprint = state.fingerprint;
    await step(pause(100));
  }
}
function loadPlaywright() {
  for (const name of ['playwright', 'playwright-core']) {
    try {
      return require(name);
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') fail('MISSING_PLAYWRIGHT');
    }
  }
  fail('MISSING_PLAYWRIGHT');
}
function readIdentity(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const parts = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  if (parts.length < 20 || !/^\d+$/.test(parts[1]) || !/^\d+$/.test(parts[19])) throw new Error('invalid-proc-stat');
  return { pid, ppid: Number(parts[1]), startTicks: parts[19], state: parts[0] };
}
function readProcess(pid) {
  const root = `/proc/${pid}`;
  const identity = readIdentity(pid);
  const status = fs.readFileSync(`${root}/status`, 'utf8');
  const field = (name) => Number(status.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))?.[1] ?? -1);
  return {
    ...identity,
    seccomp: field('Seccomp'),
    seccompFilters: field('Seccomp_filters'),
    noNewPrivs: field('NoNewPrivs'),
    pidNamespace: fs.readlinkSync(`${root}/ns/pid`),
    userNamespace: fs.readlinkSync(`${root}/ns/user`),
  };
}
function processEvidence(value) {
  const { pid, seccomp, seccompFilters, noNewPrivs, pidNamespace, userNamespace } = value;
  return { pid, seccomp, seccompFilters, noNewPrivs, pidNamespace, userNamespace };
}
function descendantProcesses() {
  const processes = [];
  for (const item of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(item)) continue;
    try {
      processes.push(readIdentity(Number(item)));
    } catch (error) {
      // 没有读取 namespace 的权限不能令所属树消失；stat 不可读则清理状态未知。
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
    }
  }
  const owned = new Set([process.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of processes)
      if (owned.has(item.ppid) && !owned.has(item.pid)) {
        owned.add(item.pid);
        changed = true;
      }
  }
  return processes.filter((item) => item.pid !== process.pid && owned.has(item.pid));
}
function ownedState(identity) {
  try {
    // 清理身份只读 stat；进程的命名空间可变，不能因 readlink 被拒就宣称退出。
    const stat = fs.readFileSync(`/proc/${identity.pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    return fields[19] === identity.startTicks && fields[0] !== 'Z' ? 'owned' : 'gone';
  } catch (error) {
    // 无法检查的 PID 保持未知/占用；只有 /proc 中不存在才确认已退出。
    return error.code === 'ENOENT' || error.code === 'ESRCH' ? 'gone' : 'unknown';
  }
}
function stillOwned(identity) {
  return ownedState(identity) !== 'gone';
}
async function closeOwned(browser, identities, discoveryUncertain = false) {
  if (browser) {
    let closeTimer;
    try {
      await Promise.race([
        browser.close().catch(() => {}),
        new Promise((resolve) => {
          closeTimer = setTimeout(resolve, 4000);
        }),
      ]);
    } finally {
      clearTimeout(closeTimer);
    }
  }
  for (const item of descendantProcesses()) identities.set(item.pid, item);
  const live = () => [...identities.values()].filter(stillOwned);
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const item of live()) {
      if (ownedState(item) !== 'owned') continue;
      try {
        process.kill(item.pid, signal);
      } catch {
        /* 只处理仍匹配 startTicks 的所属 PID。 */
      }
    }
    for (let i = 0; i < 20 && live().length; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !discoveryUncertain && live().length === 0;
}
function parseDiagnostics(text) {
  const rows = text.split(/\r?\n/).map((row) => row.trim());
  const values = (label) =>
    rows.flatMap((row) => {
      // Chromium 153 的表格以 tab 分隔；完整标签避免把 TSYNC 当成 seccomp 状态。
      const tab = row.indexOf('\t');
      if (tab >= 0) return row.slice(0, tab).trim().toLowerCase() === label.toLowerCase() ? [row.slice(tab + 1).trim()] : [];
      const match = new RegExp(`^${label}(?: +(.*))?$`, 'i').exec(row);
      return match ? [match[1] ?? ''] : [];
    });
  const one = (items, pattern) => items.length === 1 && pattern.test(items[0]);
  const enabled = /^(?:Yes|Enabled)$/i;
  const legacy = values('Namespace sandbox');
  const modern = values('Layer 1 Sandbox');
  return {
    namespaceSandbox:
      legacy.length + modern.length > 0 && (!legacy.length || one(legacy, enabled)) && (!modern.length || one(modern, /^Namespace$/i)),
    pidNamespaces: one(values('PID namespaces'), enabled),
    seccompBpf: one(values('Seccomp-BPF sandbox'), enabled),
  };
}
function validateIsolation({ args, diagnostic, browser, renderers, elf }) {
  const forbidden = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-seccomp-filter-sandbox',
    '--disable-namespace-sandbox',
    '--single-process',
    '--in-process-gpu',
    '--remote-debugging-port',
  ];
  if (
    !elf ||
    !args.includes('--remote-debugging-pipe') ||
    args.some((arg) => forbidden.some((name) => arg === name || arg.startsWith(`${name}=`)))
  )
    fail('SANDBOX_UNPROVEN');
  if (!diagnostic.namespaceSandbox || !diagnostic.pidNamespaces || !diagnostic.seccompBpf || !renderers.length || renderers.length > 16)
    fail('SANDBOX_UNPROVEN');
  for (const renderer of renderers) {
    if (
      renderer.seccomp !== 2 ||
      renderer.noNewPrivs !== 1 ||
      renderer.seccompFilters <= browser.seccompFilters ||
      renderer.pidNamespace === browser.pidNamespace
    )
      fail('SANDBOX_UNPROVEN');
  }
}
async function inspectIsolation(browser, cdp, diagnostic, step) {
  const command = await step(cdp.send('Browser.getBrowserCommandLine'));
  const info = await step(cdp.send('SystemInfo.getProcessInfo'));
  const browserInfo = info.processInfo.find((item) => item.type === 'browser');
  if (!browserInfo) fail('SANDBOX_UNPROVEN');
  const owned = new Map(descendantProcesses().map((item) => [item.pid, item]));
  if (!owned.has(browserInfo.id)) fail('SANDBOX_UNPROVEN');
  const browserProcess = readProcess(browserInfo.id);
  const executable = fs.readlinkSync(`/proc/${browserInfo.id}/exe`);
  const fd = fs.openSync(`/proc/${browserInfo.id}/exe`, 'r');
  const header = Buffer.alloc(20);
  try {
    fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const elf =
    header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) &&
    header[4] === 2 &&
    header[5] === 1 &&
    header.readUInt16LE(18) === { x64: 62, arm64: 183 }[process.arch];
  const args = fs.readFileSync(`/proc/${browserInfo.id}/cmdline`, 'utf8').split('\0').filter(Boolean);
  // CDP 与 /proc 必须对控制模式给出相同结论。
  if (!command.arguments.includes('--remote-debugging-pipe')) fail('SANDBOX_UNPROVEN');
  const renderers = info.processInfo
    .filter((item) => item.type === 'renderer')
    .map((item) => {
      if (!owned.has(item.id)) fail('SANDBOX_UNPROVEN');
      return readProcess(item.id);
    });
  validateIsolation({ args, diagnostic, browser: browserProcess, renderers, elf });
  return {
    cdp,
    launch: {
      chromiumSandbox: true,
      debuggingPipe: true,
      noSandboxFlag: false,
      browserPid: browserInfo.id,
      browserVersion: browser.version(),
      executable,
      elf,
    },
    sandbox: { diagnostic, browser: processEvidence(browserProcess), renderers: renderers.map(processEvidence) },
  };
}

async function proveIsolation(browser, context, step) {
  const cdp = await step(browser.newBrowserCDPSession());
  const internal = await step(context.newPage());
  await step(internal.goto('chrome://sandbox/', { waitUntil: 'domcontentloaded', timeout: 5000 }));
  const diagnostic = parseDiagnostics(await step(internal.locator('body').innerText({ timeout: 3000 })));
  // 诊断页与网页不共享 Page；网页开始于受控空白页。
  const page = await step(context.newPage());
  const proof = await inspectIsolation(browser, cdp, diagnostic, step);
  await step(internal.close());
  return { ...proof, page };
}

// 响应阶段在跟随 Location 之前暂停；绝不解析或放行其下一跳。
const RESTRICTED_CSP = "worker-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; form-action 'none'";
function responseGateDecision(event, mainFrameId) {
  if (event.responseErrorReason) {
    const known = [
      'Failed',
      'Aborted',
      'TimedOut',
      'AccessDenied',
      'ConnectionClosed',
      'ConnectionReset',
      'ConnectionRefused',
      'ConnectionAborted',
      'ConnectionFailed',
      'NameNotResolved',
      'InternetDisconnected',
      'AddressUnreachable',
      'BlockedByClient',
      'BlockedByResponse',
    ];
    return known.includes(event.responseErrorReason) ? `response-error-${event.responseErrorReason}` : 'response-error';
  }
  if (!Number.isInteger(event.responseStatusCode)) return 'missing-response-stage';
  if (event.responseStatusCode >= 300 && event.responseStatusCode < 400) return 'redirect-response';
  return requestDecision({
    url: event.request.url,
    method: event.request.method,
    mainFrame: event.frameId === mainFrameId,
    navigation: event.resourceType === 'Document',
    redirected: Boolean(event.redirectedRequestId),
  });
}
async function gateResponse(cdp, event, mainFrameId) {
  const reason = responseGateDecision(event, mainFrameId);
  if (reason) {
    await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
    return { admitted: false, reason };
  }
  const params = { requestId: event.requestId };
  if (event.resourceType === 'Document') {
    params.responseCode = event.responseStatusCode;
    params.responseHeaders = [...(event.responseHeaders || []), { name: 'Content-Security-Policy', value: RESTRICTED_CSP }];
  }
  // 若 Chromium 不支持这个命令，则整轮失败，不 fallback 到绕过拦截的 continueRequest。
  await cdp.send('Fetch.continueResponse', params);
  return { admitted: true, networkId: event.networkId, status: event.responseStatusCode };
}
function createDocumentGuard(frameId) {
  let identity = null;
  let responseSeen = false;
  let epoch = 0;
  return {
    request(event) {
      if (event.type !== 'Document' || event.frameId !== frameId) return;
      if (
        identity ||
        event.redirectResponse ||
        event.request.url !== TARGET ||
        event.request.method !== 'GET' ||
        !event.requestId ||
        !event.loaderId
      )
        fail('CAPTURE_FAILED');
      identity = { frameId, requestId: event.requestId, loaderId: event.loaderId };
    },
    response(event) {
      if (event.type !== 'Document' || event.frameId !== frameId) return;
      if (
        !identity ||
        responseSeen ||
        event.requestId !== identity.requestId ||
        event.loaderId !== identity.loaderId ||
        event.response.url !== TARGET ||
        event.response.status !== 200
      )
        fail('CAPTURE_FAILED');
      responseSeen = true;
    },
    commit(frame) {
      if (frame.id !== frameId) return;
      if (!identity || ++epoch !== 1 || frame.loaderId !== identity.loaderId || frame.url !== TARGET) fail('CAPTURE_FAILED');
    },
    assert(frame, receipt) {
      if (
        !identity ||
        !responseSeen ||
        epoch !== 1 ||
        frame.id !== frameId ||
        frame.loaderId !== identity.loaderId ||
        frame.url !== TARGET ||
        !receipt ||
        receipt.networkId !== identity.requestId ||
        receipt.status !== 200
      )
        fail('CAPTURE_FAILED');
      return { ...identity, epoch };
    },
    get requestId() {
      return identity?.requestId ?? null;
    },
    get epoch() {
      return epoch;
    },
  };
}
function assertStableDom(before, after) {
  if (
    before.observationId !== after.observationId ||
    before.mutations !== after.mutations ||
    before.title !== after.title ||
    before.text !== after.text ||
    before.truncated !== after.truncated
  )
    fail('CAPTURE_FAILED');
}
const OBSERVER_EXPRESSION = `(() => {
  if (Object.hasOwn(globalThis, '__wslObservation')) throw new Error('already-observed');
  const state = { observationId: crypto.randomUUID(), mutations: 0 };
  const observer = new MutationObserver(records => { state.mutations += records.length; });
  observer.observe(document, {subtree: true, childList: true, attributes: true, characterData: true});
  Object.defineProperty(globalThis, '__wslObservation', {value: {state, observer}});
  return state.observationId;
})()`;

// 固定表达式只在 CDP isolated world 中运行，不接收网页或宿主提供的代码。
const DOM_EXPRESSION = `(() => {
  const maxBytes = 65536, maxNodes = 10000;
  const root = document.body;
  if (!root) throw new Error('missing-body');
  const encoder = new TextEncoder();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = '', bytes = 0, visited = 0, truncated = false, node;
  while ((node = walker.nextNode())) {
    if (++visited > maxNodes) { truncated = true; break; }
    const element = node.parentElement;
    if (!element || element.closest('script,style,noscript,template') || !element.getClientRects().length) continue;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.visibility === 'collapse') continue;
    const part = node.data.slice(0, maxBytes).replace(/\\s+/g, ' ').trim();
    if (!part) continue;
    for (const char of (text ? '\\n' : '') + part) {
      const size = encoder.encode(char).length;
      if (bytes + size > maxBytes) { truncated = true; break; }
      text += char; bytes += size;
    }
    if (truncated || node.data.length > maxBytes) { truncated = true; break; }
  }
  const observation = globalThis.__wslObservation;
  if (!observation) throw new Error('missing-observation');
  observation.state.mutations += observation.observer.takeRecords().length;
  return {title: document.title.slice(0, 4096), text, truncated, observationId: observation.state.observationId, mutations: observation.state.mutations};
})()`;
async function runCapture(request, options = {}) {
  parseRequest(JSON.stringify(request));
  if (process.platform !== 'linux') fail('PLATFORM');
  const controller = new AbortController();
  let abortCode = 'CANCELLED';
  const abort = (code) => {
    if (!controller.signal.aborted) {
      abortCode = code;
      controller.abort();
    }
  };
  const externalAbort = () => abort('CANCELLED');
  options.signal?.addEventListener('abort', externalAbort, { once: true });
  if (options.signal?.aborted) abort('CANCELLED');
  const deadline = setTimeout(() => abort('TIMEOUT'), LIMITS.runtime);
  const abortPromise = new Promise((_, reject) =>
    controller.signal.addEventListener('abort', () => reject(new CaptureError(abortCode)), { once: true }),
  );
  abortPromise.catch(() => {});
  const step = async (promise) => {
    if (controller.signal.aborted) {
      Promise.resolve(promise).catch(() => {});
      fail(abortCode);
    }
    return Promise.race([promise, abortPromise]);
  };
  const identities = new Map();
  let discoveryUncertain = false;
  const track = () => {
    try {
      for (const item of descendantProcesses()) identities.set(item.pid, item);
    } catch {
      discoveryUncertain = true;
      abort('CLEANUP_FAILED');
    }
  };
  const tracker = setInterval(track, 100);
  let browser = null;
  let result;
  const network = { totalRequests: 0, blocked: [], failed: [] };
  let evidence;
  let phase = 'startup';
  try {
    if (controller.signal.aborted) fail(abortCode);
    phase = 'network-readiness';
    await waitForNetworkReadiness(step, undefined, controller.signal);
    if (controller.signal.aborted) fail(abortCode);
    phase = 'startup';
    const playwright = (options.loadPlaywright || loadPlaywright)();
    try {
      // 不 race launch：即使宿主取消，也要等 launch settle 才能关闭得到的 Browser。
      browser = await playwright.chromium.launch({
        headless: true,
        channel: 'chromium',
        chromiumSandbox: true,
        // Chromium 不自动采用 guest 的 http_proxy；固定复用现有沙箱网关执行出站策略。
        proxy: { server: 'http://gateway.docker.internal:3128' },
        timeout: 10000,
        args: ['--enable-automation', '--lang=en-US', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      });
    } catch (error) {
      if (controller.signal.aborted) fail(abortCode);
      if (typeof error?.message === 'string' && /Executable doesn't exist/.test(error.message)) fail('MISSING_CHROMIUM');
      fail('LAUNCH_FAILED');
    }
    track();
    const context = await step(
      browser.newContext({
        ignoreHTTPSErrors: false,
        acceptDownloads: false,
        serviceWorkers: 'block',
        permissions: [],
        deviceScaleFactor: 1,
        viewport: { width: 1280, height: 800 },
      }),
    );
    let proof;
    try {
      proof = await proveIsolation(browser, context, step);
    } catch {
      if (controller.signal.aborted) fail(abortCode);
      fail('SANDBOX_UNPROVEN');
    }
    evidence = {
      guest: { platform: 'linux', architecture: process.arch, uid: process.getuid(), nodeVersion: process.version },
      launch: proof.launch,
      sandbox: proof.sandbox,
    };
    const page = proof.page;
    const pageCdp = await step(context.newCDPSession(page));
    await step(pageCdp.send('Page.enable'));
    const initialTree = await step(pageCdp.send('Page.getFrameTree'));
    const mainFrameId = initialTree.frameTree.frame.id;
    const documentGuard = createDocumentGuard(mainFrameId);
    const gatedResponses = new Map();
    const receivedResponses = new Set();
    let mainBytes = 0;
    await step(pageCdp.send('Network.enable', { maxTotalBufferSize: 8388608, maxResourceBufferSize: LIMITS.response }));
    const guardedEvent = (operation) => (event) => {
      try {
        operation(event);
      } catch {
        abort('CAPTURE_FAILED');
      }
    };
    pageCdp.on(
      'Network.requestWillBeSent',
      guardedEvent((event) => documentGuard.request(event)),
    );
    pageCdp.on(
      'Network.responseReceived',
      guardedEvent((event) => {
        receivedResponses.add(event.requestId);
        documentGuard.response(event);
      }),
    );
    pageCdp.on(
      'Page.frameNavigated',
      guardedEvent((event) => documentGuard.commit(event.frame)),
    );
    pageCdp.on('Page.navigatedWithinDocument', (event) => {
      if (event.frameId === mainFrameId) abort('CAPTURE_FAILED');
    });
    pageCdp.on('Network.dataReceived', (event) => {
      if (event.requestId === documentGuard.requestId) {
        mainBytes += event.dataLength;
        if (mainBytes > LIMITS.response) abort('RESPONSE_LIMIT');
      }
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && frame.url() !== TARGET) abort('CAPTURE_FAILED');
    });
    page.on('download', (download) => {
      void download.cancel().catch(() => {});
      abort('CAPTURE_FAILED');
    });
    context.on('page', (extra) => {
      if (extra !== page) {
        void extra.close().catch(() => {});
        abort('CAPTURE_FAILED');
      }
    });
    const record = (list, url, reason) => {
      if (list.length < 32) list.push({ ...safeLocation(url), reason });
    };
    // 独立 CDP session 的响应拦截必须在导航前启用。每个已收到响应还需有 gate 回执。
    pageCdp.on('Fetch.requestPaused', (event) => {
      void (async () => {
        try {
          if (controller.signal.aborted) {
            await pageCdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' });
            return;
          }
          const receipt = await gateResponse(pageCdp, event, mainFrameId);
          if (receipt.admitted) {
            if (!receipt.networkId) {
              abort('NETWORK_FAILED');
              return;
            }
            gatedResponses.set(receipt.networkId, receipt);
          } else {
            record(network.blocked, event.request.url, receipt.reason);
            if (event.resourceType === 'Document' && event.frameId === mainFrameId) abort('NETWORK_FAILED');
          }
        } catch {
          abort('NETWORK_FAILED');
        }
      })();
    });
    await step(pageCdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Response' }] }));
    let initialNavigationRequest = null;
    await step(
      context.routeWebSocket('**/*', (socket) => {
        record(network.blocked, socket.url(), 'websocket');
        socket.close();
      }),
    );
    await step(
      context.route('**/*', async (route) => {
        if (controller.signal.aborted) {
          await route.abort('blockedbyclient').catch(() => {});
          return;
        }
        const req = route.request();
        network.totalRequests++;
        if (network.totalRequests > 256) abort('NETWORK_FAILED');
        let mainFrame = false;
        try {
          mainFrame = req.frame() === page.mainFrame();
        } catch {
          /* worker 请求不接受。 */
        }
        if (mainFrame && req.isNavigationRequest()) {
          if (initialNavigationRequest) {
            abort('CAPTURE_FAILED');
            await route.abort('blockedbyclient').catch(() => {});
            return;
          }
          initialNavigationRequest = req;
        }
        const reason =
          network.totalRequests > 256
            ? 'request-budget'
            : requestDecision({
                url: req.url(),
                method: req.method(),
                mainFrame,
                navigation: req.isNavigationRequest(),
                redirected: Boolean(req.redirectedFrom()),
              });
        try {
          if (reason) {
            record(network.blocked, req.url(), reason);
            await route.abort('blockedbyclient');
          } else await route.continue();
        } catch {
          /* close 时已失效的 route 不产生未处理 rejection。 */
        }
      }),
    );
    page.on('requestfailed', (req) => {
      const reason = req.failure()?.errorText;
      record(network.failed, req.url(), typeof reason === 'string' && /^net::[A-Z0-9_]{1,80}$/.test(reason) ? reason : 'request-failed');
    });
    phase = 'navigation';
    let response;
    try {
      response = await step(page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 20000 }));
    } catch {
      if (controller.signal.aborted) fail(abortCode);
      fail('NETWORK_FAILED');
    }
    if (!response || response.status() !== 200 || page.url() !== TARGET || response.request().redirectedFrom()) {
      if (response) record(network.failed, TARGET, `http-status-${response.status()}`);
      fail('NETWORK_FAILED');
    }
    if (response.request() !== initialNavigationRequest) fail('CAPTURE_FAILED');
    const assertDocument = async () => {
      const tree = await step(pageCdp.send('Page.getFrameTree'));
      if (controller.signal.aborted || page.url() !== TARGET) fail(controller.signal.aborted ? abortCode : 'CAPTURE_FAILED');
      return documentGuard.assert(tree.frameTree.frame, gatedResponses.get(documentGuard.requestId));
    };
    phase = 'document-identity';
    const documentIdentity = await assertDocument();
    const captureEpoch = documentIdentity.epoch;
    const headers = response.headers();
    if (!/^text\/html(?:;|$)/i.test(headers['content-type'] || '')) fail('CAPTURE_FAILED');
    if (Number(headers['content-length'] || 0) > LIMITS.response) fail('RESPONSE_LIMIT');
    await assertDocument();
    phase = 'response-body';
    const source = await step(response.body());
    await assertDocument();
    if (source.length > LIMITS.response) fail('RESPONSE_LIMIT');
    phase = 'observer-installation';
    const world = await step(
      pageCdp.send('Page.createIsolatedWorld', { frameId: mainFrameId, worldName: 'wsl-capture', grantUniveralAccess: false }),
    );
    const evaluate = (expression) =>
      step(pageCdp.send('Runtime.evaluate', { expression, contextId: world.executionContextId, returnByValue: true, awaitPromise: false }));
    const installed = await evaluate(OBSERVER_EXPRESSION);
    if (installed.exceptionDetails || typeof installed.result.value !== 'string') fail('CAPTURE_FAILED');
    const readDom = async () => {
      await assertDocument();
      const domResult = await evaluate(DOM_EXPRESSION);
      await assertDocument();
      const dom = domResult.result.value;
      if (
        domResult.exceptionDetails ||
        !dom ||
        typeof dom.text !== 'string' ||
        typeof dom.title !== 'string' ||
        typeof dom.truncated !== 'boolean' ||
        Buffer.byteLength(dom.text) > LIMITS.text ||
        dom.title.length > 4096 ||
        dom.observationId !== installed.result.value ||
        !Number.isSafeInteger(dom.mutations) ||
        dom.mutations < 0
      )
        fail('CAPTURE_FAILED');
      return dom;
    };
    phase = 'dom-before';
    const dom = await readDom();
    await assertDocument();
    phase = 'screenshot';
    // 默认隐藏 caret 会写入并恢复 input 的 style，污染严格的 DOM 变动计数。
    // 采集器保持页面原状；任何站点自身变动仍由前后 observer/identity 检查拒绝。
    const png = await step(page.screenshot({ type: 'png', fullPage: false, timeout: 5000, animations: 'allow', caret: 'initial' }));
    if (png.length > LIMITS.screenshot) fail('SCREENSHOT_LIMIT');
    await assertDocument();
    phase = 'dom-after-screenshot';
    assertStableDom(dom, await readDom());
    // 真实站点可能触发 renderer 换进程；采集后再次检查该 Browser 的全部 renderer。
    try {
      phase = 'final-isolation';
      const finalProof = await inspectIsolation(browser, proof.cdp, proof.sandbox.diagnostic, step);
      evidence.launch = finalProof.launch;
      evidence.sandbox = finalProof.sandbox;
    } catch {
      if (controller.signal.aborted) fail(abortCode);
      fail('SANDBOX_UNPROVEN');
    }
    await assertDocument();
    phase = 'target-identity';
    const target = await step(pageCdp.send('Target.getTargetInfo'));
    await assertDocument();
    assertStableDom(dom, await readDom());
    if ([...receivedResponses].some((id) => !gatedResponses.has(id))) fail('NETWORK_FAILED');
    // DOM counter/text 在截图前后稳定；不声称异步字体/视频/画布像素具有原子时点。
    const snapshot = {
      page: {
        kind: 'sandbox-chromium',
        sandboxName: request.sandboxName,
        browserInstanceId: crypto.randomUUID(),
        targetId: target.targetInfo.targetId,
        navigationEpoch: captureEpoch,
        url: TARGET,
        title: dom.title,
      },
      requestedUrl: TARGET,
      url: TARGET,
      title: dom.title,
      text: dom.text,
      capturedAt: new Date().toISOString(),
      sourceSha256: sha256(source),
      contentSha256: sha256(dom.text),
      truncated: dom.truncated,
      extractionVersion: 'rendered-dom-text-v1',
      sourceKind: 'decoded-main-response',
      captureId: request.captureId,
      screenshotSha256: sha256(png),
    };
    result = {
      protocolVersion: 1,
      ok: true,
      snapshot,
      screenshot: { mimeType: 'image/png', base64: png.toString('base64'), sha256: sha256(png), bytes: png.length },
      evidence,
      network,
    };
  } catch (error) {
    const code = error instanceof CaptureError ? error.code : 'CAPTURE_FAILED';
    result = {
      protocolVersion: 1,
      ok: false,
      error: { code, message: `${MESSAGES[code]} [${phase}]` },
      ...(evidence ? { evidence } : {}),
      network,
    };
  } finally {
    clearTimeout(deadline);
    clearInterval(tracker);
    options.signal?.removeEventListener('abort', externalAbort);
    let browserClosed = false;
    try {
      browserClosed = await closeOwned(browser, identities, discoveryUncertain);
    } catch {
      /* 清理不确定必须失败。 */
    }
    if (!browserClosed)
      result = {
        protocolVersion: 1,
        ok: false,
        error: { code: 'CLEANUP_FAILED', message: MESSAGES.CLEANUP_FAILED },
        ...(evidence ? { evidence } : {}),
        network,
      };
    result.cleanup = { browserClosed };
  }
  return result;
}
async function main() {
  // 可信程序运行时不将任何库日志混入结果帧。
  console.log = console.info = console.warn = console.error = () => {};
  const controller = new AbortController();
  let input = '';
  let started = false;
  let settled = false;
  let firstTimer = setTimeout(
    () =>
      complete({ protocolVersion: 1, ok: false, error: { code: 'TIMEOUT', message: MESSAGES.TIMEOUT }, cleanup: { browserClosed: true } }),
    5000,
  );
  const complete = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(firstTimer);
    process.stdin.destroy();
    let line = JSON.stringify(result);
    if (Buffer.byteLength(line) > LIMITS.output)
      line = JSON.stringify({
        protocolVersion: 1,
        ok: false,
        error: { code: 'CAPTURE_FAILED', message: MESSAGES.CAPTURE_FAILED },
        cleanup: result.cleanup,
      });
    process.stdout.write(`${line}\n`, () => {
      // 完整结果帧表示传输成功；业务成功以 ok 字段判断。
      process.exitCode = 0;
    });
  };
  process.on('SIGTERM', () => controller.abort());
  process.on('SIGINT', () => controller.abort());
  process.stdin.on('end', () => {
    if (!settled) controller.abort();
    if (!started)
      complete({
        protocolVersion: 1,
        ok: false,
        error: { code: 'INVALID_REQUEST', message: MESSAGES.INVALID_REQUEST },
        cleanup: { browserClosed: true },
      });
  });
  process.stdin.on('error', () => controller.abort());
  process.stdout.on('error', () => {
    controller.abort();
  });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (settled) return;
    if (started) {
      controller.abort();
      return;
    }
    input += chunk;
    if (Buffer.byteLength(input) > LIMITS.input || input.includes('\r')) {
      complete({
        protocolVersion: 1,
        ok: false,
        error: { code: 'INVALID_REQUEST', message: MESSAGES.INVALID_REQUEST },
        cleanup: { browserClosed: true },
      });
      return;
    }
    const index = input.indexOf('\n');
    if (index < 0) return;
    if (index !== input.length - 1) {
      complete({
        protocolVersion: 1,
        ok: false,
        error: { code: 'INVALID_REQUEST', message: MESSAGES.INVALID_REQUEST },
        cleanup: { browserClosed: true },
      });
      return;
    }
    started = true;
    clearTimeout(firstTimer);
    firstTimer = null;
    let request;
    try {
      request = parseRequest(input.slice(0, -1));
    } catch (error) {
      complete({ protocolVersion: 1, ok: false, error: { code: error.code, message: error.message }, cleanup: { browserClosed: true } });
      return;
    }
    void runCapture(request, { signal: controller.signal }).then(complete, (error) =>
      complete({
        protocolVersion: 1,
        ok: false,
        error: {
          code: error instanceof CaptureError ? error.code : 'CAPTURE_FAILED',
          message: error instanceof CaptureError ? error.message : MESSAGES.CAPTURE_FAILED,
        },
        cleanup: { browserClosed: true },
      }),
    );
  });
}
module.exports = {
  LIMITS,
  CaptureError,
  parseRequest,
  responseGateDecision,
  gateResponse,
  createDocumentGuard,
  assertStableDom,
  descendantProcesses,
  requestDecision,
  truncateUtf8,
  safeLocation,
  inspectIpv6Readiness,
  waitForNetworkReadiness,
  parseDiagnostics,
  validateIsolation,
  closeOwned,
  stillOwned,
  runCapture,
  main,
};
if (require.main === module || process.argv[1] === undefined) void main();
