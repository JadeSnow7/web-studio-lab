import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Standalone diagnostic: no production mutation, no execution without the explicit gate.
const repository = '/Users/huaodong/.codex/worktrees/bf64/web-studio-lab';
const binary = '/opt/homebrew/bin/sbx';
const sandboxName = 'wsl-sbx-smoke-20261006';
const target = 'https://docs.docker.com/';
const source = readFileSync(path.join(repository, 'apps/service/src/guest-browser.cjs'), 'utf8');
const sourceSha256 = createHash('sha256').update(source).digest('hex');
const captureId = randomUUID();
const request = { operation: 'capture', url: target, sandboxName, captureId };
if (process.env['WSL_RUN_GUEST_NETWORK_DIAG'] !== '1') {
  console.log(JSON.stringify({ preparedOnly: true, networkRequests: 0, sourceSha256, target, sandboxName }));
  process.exit(0);
}
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error('Explicit absolute diagnostic output path required');
const inspection = spawnSync(binary, ['inspect', '--json', sandboxName], {
  encoding: 'utf8', timeout: 20000, maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
});
if (inspection.status !== 0) throw new Error('Sandbox identity inspection failed');
const identity = JSON.parse(inspection.stdout);
if (identity.name !== sandboxName || identity.agent !== 'codex' || identity.state !== 'running' || !Array.isArray(identity.runtime_mounts) || identity.runtime_mounts.length !== 0) throw new Error('Expected already-running mountless Codex sandbox');

const guest = `
'use strict';
process.argv[1] = 'wsl-readonly-network-diagnostic';
const Module = require('node:module');
const modulePath = '/home/agent/workspace/__wsl_readonly_capture.cjs';
const capture = new Module(modulePath, module);
capture.filename = modulePath;
capture.paths = Module._nodeModulePaths('/home/agent/workspace');
capture._compile(${JSON.stringify(source)}, modulePath);
const harness = capture.exports;
const events = [];
let omittedEvents = 0;
let sessionCount = 0;
const start = process.hrtime.bigint();
const ms = () => Number(process.hrtime.bigint() - start) / 1e6;
const errorReasons = new Set(['Failed','Aborted','TimedOut','AccessDenied','ConnectionClosed','ConnectionReset','ConnectionRefused','ConnectionAborted','ConnectionFailed','NameNotResolved','InternetDisconnected','AddressUnreachable','BlockedByClient','BlockedByResponse']);
const reason = (value) => errorReasons.has(value) ? value : value == null ? null : 'unclassified';
const netError = (value) => typeof value === 'string' && /^net::ERR_[A-Z0-9_]+$/.test(value) ? value : 'unclassified';
const location = (raw) => { try { const url = new URL(raw); return { origin: url.origin.slice(0,128), fixedTarget: url.href === ${JSON.stringify(target)} }; } catch { return { origin: 'invalid', fixedTarget: false }; } };
const record = (event, data) => { if (events.length < 1000) events.push({ sequence: events.length + 1, monotonicMs: ms(), event, ...data }); else omittedEvents++; };
function loadPlaywright() {
  let native;
  for (const name of ['playwright','playwright-core']) {
    try { native = require(name); break; } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  }
  if (!native) throw new harness.CaptureError('MISSING_PLAYWRIGHT');
  return { chromium: { launch: async (options) => {
    if (options.chromiumSandbox !== true || options.proxy?.server !== 'http://gateway.docker.internal:3128') throw new Error('Diagnostic launch policy changed');
    record('launch-policy', { chromiumSandbox: true, configuredGateway: true });
    const browser = await native.chromium.launch(options);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (options) => {
      if (options.ignoreHTTPSErrors !== false) throw new Error('Certificate validation must remain enabled');
      record('context-policy', { ignoreHTTPSErrors: false });
      const context = await newContext(options);
      const newSession = context.newCDPSession.bind(context);
      context.newCDPSession = async (...args) => {
        const cdp = await newSession(...args);
        const session = ++sessionCount;
        cdp.on('Network.loadingFailed', (event) => record('Network.loadingFailed', {
          session, requestId: event.requestId, resourceType: event.type,
          errorText: netError(event.errorText), canceled: event.canceled === true,
          blockedReason: typeof event.blockedReason === 'string' && /^[a-z-]+$/.test(event.blockedReason) ? event.blockedReason : null,
        }));
        cdp.on('Fetch.requestPaused', (event) => record('Fetch.requestPaused', {
          session, requestId: event.requestId, networkId: event.networkId ?? null,
          resourceType: event.resourceType, responseStatusCode: event.responseStatusCode ?? null,
          responseErrorReason: reason(event.responseErrorReason), ...location(event.request.url),
        }));
        const send = cdp.send.bind(cdp);
        cdp.send = (method, params) => {
          if (method === 'Fetch.failRequest') record('Fetch.failRequest-before-send', {
            session, requestId: params.requestId, errorReason: reason(params.errorReason),
          });
          return send(method, params);
        };
        return cdp;
      };
      return context;
    };
    return browser;
  } } };
}
(async () => {
  const result = await harness.runCapture(${JSON.stringify(request)}, { loadPlaywright });
  // Preserve isolation/cleanup evidence, omit all content, screenshot data and request headers/bodies.
  console.log(JSON.stringify({ sourceSha256: ${JSON.stringify(sourceSha256)}, request: ${JSON.stringify(request)},
    events, omittedEvents, runtimeBudgetMs: harness.LIMITS.runtime,
    result: { ok: result.ok, error: result.error ?? null, cleanup: result.cleanup,
      evidence: result.evidence ?? null, network: result.network,
      screenshotMetadata: result.ok ? { bytes: result.screenshot.bytes, sha256: result.screenshot.sha256 } : null },
  }));
})().catch(() => { console.log(JSON.stringify({ diagnosticFailed: true, cleanupConfirmed: false, events, omittedEvents })); process.exitCode = 1; });
`;
const execution = spawnSync(binary, ['exec', '-i', '-w', '/home/agent/workspace', sandboxName, 'node', '-e', guest], {
  encoding: 'utf8', timeout: 70000, maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'],
});
const lines = execution.stdout.trim().split('\n');
if (execution.status !== 0 || lines.length !== 1) {
  writeFileSync(output, JSON.stringify({ diagnosticFailed: true, status: execution.status, signal: execution.signal,
    cleanupConfirmed: false, sourceSha256, target, sandboxName, stdoutBytes: Buffer.byteLength(execution.stdout) }, null, 2) + '\n', { mode: 0o600 });
  throw new Error('Diagnostic transport failed; no raw stderr or partial stdout exported');
}
const result = JSON.parse(lines[0]);
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
if (result.result?.cleanup?.browserClosed !== true) throw new Error('Diagnostic owned browser cleanup unconfirmed');
console.log(JSON.stringify({ output, sourceSha256, events: result.events.length, captureOk: result.result.ok, browserClosed: true }));
