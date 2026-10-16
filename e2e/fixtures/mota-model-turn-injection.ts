/**
 * No-model live test only. Forward real send/register/acquire and substitute only
 * SbxConnection.start(mode=codex,motaControl=true). Main scope, CodexChat's tool
 * budget, service ownership, Browser input and map persistence remain real.
 * The original built service is read, never modified; unexpected builds fail closed.
 */
const controlledTurn = String.raw`
const testPort = process.parentPort;
const originalStart = SbxConnection.prototype.start;
let testTurn = null;
SbxConnection.prototype.start = function(start, onFrame, ...rest) {
  if (start.mode !== 'codex' || start.motaControl !== true) return originalStart.call(this, start, onFrame, ...rest);
  if (testTurn && !testTurn.closed) throw new Error('e2e_mota_turn_already_active');
  if (!start.observation || !start.strictWorkspace || !start.workspace) throw new Error('e2e_mota_scope_missing');
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const turn = { closed: false, onFrame, pending: new Set(), workspace: structuredClone(start.workspace) };
  testTurn = turn;
  const close = () => {
    if (!turn.closed) {
      turn.closed = true;
      for (const id of turn.pending) testPort.postMessage({ __wslMotaTest: 'reply', id, error: 'controlled_turn_closed' });
      turn.pending.clear();
      onFrame({ type: 'workspace', ...turn.workspace });
      onFrame({ type: 'cleanup', ok: true });
      finish({ error: null, exitCode: 0, confirmed: true });
      testPort.postMessage({ __wslMotaTest: 'closed' });
    }
    return done;
  };
  setImmediate(() => {
    onFrame({ type: 'ready' });
    onFrame({ type: 'output', stream: 'stdout', data: JSON.stringify({ type: 'thread.started', thread_id: 'e2e-mota-controlled-' + start.workspace.runId }) + '\n' });
    testPort.postMessage({ __wslMotaTest: 'ready', runId: start.workspace.runId });
  });
  return {
    done, close, closeInput: close,
    write(frame) {
      if (frame.type === 'close' || frame.type === 'close-input') { void close(); return; }
      if (frame.type !== 'observation-result' || !turn.pending.delete(frame.id)) throw new Error('e2e_mota_unexpected_reply');
      testPort.postMessage({ __wslMotaTest: 'reply', id: frame.id, result: frame.result });
    },
  };
};
globalThis.__wslMotaTestReceive = data => {
  if (data.__wslMotaTest !== 'call' || !testTurn || testTurn.closed) {
    testPort.postMessage({ __wslMotaTest: 'reply', id: data.id, error: 'controlled_turn_unavailable' });
    return;
  }
  if (!['app.mota.state', 'app.mota.act', 'app.mota.map.read', 'app.mota.map.set'].includes(data.tool)) throw new Error('e2e_mota_tool_forbidden');
  testTurn.pending.add(data.id);
  testTurn.onFrame({ type: 'observation-call', id: data.id, tool: data.tool, args: data.args });
};
`;

export const motaModelTurnInjection = String.raw`
const { utilityProcess } = require('electron');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const controlledSource = __WSL_CONTROLLED_TURN__;
const originalMotaFork = utilityProcess.fork.bind(utilityProcess);
const motaLive = (globalThis.__wslMotaModelTurn = { child: null, ready: false, runId: null, starts: 0, sends: 0, replies: new Map(), mode: 'scripted-no-model-codex-process-replaced' });
utilityProcess.fork = (entry, args, options) => {
  if (!String(entry).endsWith('/service/out/index.cjs')) throw new Error('e2e_mota_unexpected_service_entry');
  const wrapper = path.join(mkdtempSync(path.join(tmpdir(), 'wsl-mota-controlled-turn-')), 'service.cjs');
  const source = [
    "const fs = require('node:fs');",
    "const Module = require('node:module');",
    "const path = require('node:path');",
    'const entry = ' + JSON.stringify(entry) + ';',
    "const source = fs.readFileSync(entry, 'utf8');",
    "for (const marker of ['class SbxConnection {', 'class CodexChat {', 'apps.registerMotaTask(request.payload.motaTask)']) {",
    "  if (source.split(marker).length !== 2) throw new Error('e2e_mota_build_marker_not_unique');",
    '}',
    'const port = process.parentPort;',
    'const on = port.on.bind(port);',
    "port.on = (name, listener) => on(name, name === 'message' ? event => {",
    '  if (event.data && event.data.__wslMotaTest) {',
    "    if (typeof globalThis.__wslMotaTestReceive !== 'function') throw new Error('e2e_mota_hook_not_ready');",
    '    globalThis.__wslMotaTestReceive(event.data);',
    '  } else listener(event);',
    '} : listener);',
    'const compiled = new Module(entry, module);',
    'compiled.filename = entry;',
    'compiled.paths = Module._nodeModulePaths(path.dirname(entry));',
    'compiled._compile(source + "\\n" + ' + JSON.stringify(controlledSource) + ', entry);',
  ].join('\n');
  writeFileSync(wrapper, source, { flag: 'wx', mode: 0o600 });
  const child = originalMotaFork(wrapper, args, options);
  motaLive.child = child;
  const emit = child.emit.bind(child);
  child.emit = (name, message, ...rest) => {
    if (name === 'message' && message && message.__wslMotaTest) {
      if (message.__wslMotaTest === 'ready') { motaLive.ready = true; motaLive.runId = message.runId; motaLive.starts++; }
      else if (message.__wslMotaTest === 'closed') motaLive.ready = false;
      else if (message.__wslMotaTest === 'reply') {
        const pending = motaLive.replies.get(message.id); motaLive.replies.delete(message.id);
        if (pending) message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result);
      }
      return true;
    }
    return emit(name, message, ...rest);
  };
  const post = child.postMessage.bind(child);
  child.postMessage = message => {
    if (message.method === 'send' && message.payload.motaTask) motaLive.sends++;
    return post(message);
  };
  return child;
};
globalThis.__wslMotaCall = (tool, args) => new Promise((resolve, reject) => {
  if (!motaLive.child || !motaLive.ready) return reject(new Error('controlled_mota_turn_unavailable'));
  const id = randomUUID();
  motaLive.replies.set(id, { resolve, reject });
  motaLive.child.postMessage({ __wslMotaTest: 'call', id, tool, args });
});
`.replace('__WSL_CONTROLLED_TURN__', JSON.stringify(controlledTurn));
