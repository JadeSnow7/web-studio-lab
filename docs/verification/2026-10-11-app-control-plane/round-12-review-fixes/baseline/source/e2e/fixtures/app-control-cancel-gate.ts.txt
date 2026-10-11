/** Test-only observer: delay one genuine Main reply without replacing model, cancellation, or results. */
export const appControlCancelGate = `
const { utilityProcess } = require('electron');
const originalCancelGateFork = utilityProcess.fork.bind(utilityProcess);
const gate = globalThis.__wslAppCancelGate = {
  nonce: null, target: null, held: null, second: null, releaseOnSecond: false,
  events: [], calls: [], release: null,
};
utilityProcess.fork = (...args) => {
  const child = originalCancelGateFork(...args);
  const post = child.postMessage.bind(child);
  let pending = null;
  gate.release = (reason) => {
    if (!pending) return false;
    gate.events.push({ type: 'released', reason, at: Date.now(), callId: pending.payload.callId });
    const message = pending;
    pending = null;
    post(message);
    return true;
  };
  child.on('message', (message) => {
    if (message.type === 'app-abort' && gate.target?.id === message.id)
      gate.events.push({ type: 'abort', at: Date.now(), callId: message.id });
    if (message.type !== 'app-call') return;
    gate.calls.push({ id: message.id, runId: message.scope.runId, tool: message.tool, at: Date.now(), actionType: message.args.action?.type ?? null });
    if (!gate.target && message.tool === 'app.ui.act' && message.args.action?.type === 'waitFor' &&
        message.args.action.target?.testid === gate.nonce) {
      gate.target = { id: message.id, runId: message.scope.runId, tool: message.tool, args: message.args, at: Date.now() };
      gate.events.push({ type: 'entered', at: Date.now(), callId: message.id });
    }
    if (gate.releaseOnSecond && gate.target && message.scope.runId !== gate.target.runId && message.tool === 'app.status') {
      gate.second = { id: message.id, runId: message.scope.runId, tool: message.tool, args: message.args, at: Date.now() };
      gate.releaseOnSecond = false;
      gate.release('second-real-request');
    }
  });
  child.postMessage = (message) => {
    if (message.method === 'cancel') gate.events.push({ type: 'cancel-forwarded', at: Date.now() });
    if (message.method === 'app.reply' && message.payload.callId === gate.target?.id && !gate.held) {
      pending = message;
      gate.held = { id: message.payload.callId, result: message.payload.result, at: Date.now() };
      gate.events.push({ type: 'held', at: Date.now(), callId: message.payload.callId });
      return;
    }
    return post(message);
  };
  return child;
};
`;
