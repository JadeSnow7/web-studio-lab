/**
 * 测试专用 Main 引导片段：在 Main↔service 消息边界代替 guest Codex 轮次，不调用模型。
 * - 拦截 `send`：记录 Main 冻结的观察 scope，回送一个 running 会话，Codex 与模型均不启动；
 * - `__wslAppCall` 以 service 的 `app-call` 帧身份把控制面调用交给 Main，收集 `app.reply`；
 * - 拦截被模拟会话的 `cancel`，回送 cancelled 会话。
 * 其余消息（register、app.*、observation、终端）照常转发给真实 service 与 sandbox。
 */
export const appControlInjection = `
const { utilityProcess } = require('electron');
const { randomUUID } = require('node:crypto');
const originalAppControlFork = utilityProcess.fork.bind(utilityProcess);
const live = (globalThis.__wslAppControlLive = { child: null, scopes: [], conversations: new Map(), replies: new Map(), forwarded: [] });
utilityProcess.fork = (...args) => {
  const child = originalAppControlFork(...args);
  live.child = child;
  const post = child.postMessage.bind(child);
  const answer = (id, result) => setImmediate(() => child.emit('message', { type: 'response', id, result }));
  child.postMessage = (message) => {
    if (message.method === 'send' && message.payload.observationScope) {
      live.scopes.push(message.payload.observationScope);
      const conversation = {
        conversationId: message.payload.conversationId, generation: 'e2e-' + message.id, seq: 1000000 + live.scopes.length,
        threadId: null, turnId: 'e2e-turn-' + live.scopes.length, state: 'running', messages: [], toolExecutions: [],
        warnings: [], cleanupPending: true, error: null,
      };
      live.conversations.set(message.payload.conversationId, conversation);
      return answer(message.id, conversation);
    }
    if (message.method === 'cancel' && live.conversations.has(message.payload.conversationId)) {
      const previous = live.conversations.get(message.payload.conversationId);
      const cancelled = { ...previous, seq: previous.seq + 1, state: 'cancelled', cleanupPending: false };
      live.conversations.delete(message.payload.conversationId);
      return answer(message.id, cancelled);
    }
    if (message.method === 'app.reply') {
      const resolve = live.replies.get(message.payload.callId);
      live.replies.delete(message.payload.callId);
      if (resolve) resolve(message.payload.result);
      return answer(message.id, null);
    }
    if (typeof message.method === 'string' && message.method.startsWith('app.')) live.forwarded.push(message.method);
    return post(message);
  };
  return child;
};
globalThis.__wslAppCall = (tool, args, abortAfterMs) =>
  new Promise((resolve) => {
    const scope = live.scopes[live.scopes.length - 1];
    if (!scope || !live.child) return resolve({ ok: false, tool: null, error: { code: 'no_active_run', message: 'e2e: no captured run scope' } });
    const id = randomUUID();
    live.replies.set(id, resolve);
    live.child.emit('message', { type: 'app-call', id, scope, tool, args });
    if (abortAfterMs) setTimeout(() => live.child.emit('message', { type: 'app-abort', id }), abortAfterMs);
  });
`;
