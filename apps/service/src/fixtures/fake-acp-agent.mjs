#!/usr/bin/env node
// 确定性的假 ACP Agent，只用于契约测试：不调用模型、不读写文件、不联网。
// 用法：node fake-acp-agent.mjs <scenario>。stdin/stdout 为逐行 JSON-RPC 2.0；stdin 结束即退出。
import process from 'node:process';
import { createInterface } from 'node:readline';

const scenario = process.argv[2] ?? 'reply';
let nextId = 1000;
const waiting = new Map();
let cancelled = null;
let cancelRequested = false;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const update = (sessionId, body) => send({ method: 'session/update', params: { sessionId, update: body } });
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
const chunk = (sessionId, text, messageId) =>
  update(sessionId, { sessionUpdate: 'agent_message_chunk', ...(messageId ? { messageId } : {}), content: { type: 'text', text } });

const capabilities = {
  loadSession: scenario !== 'noload',
  promptCapabilities: { image: false, audio: false, embeddedContext: false },
  mcpCapabilities: { http: false, sse: false },
};

async function prompt(id, { sessionId }) {
  if (scenario === 'reply' || scenario === 'noload') {
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '思考' } });
    chunk(sessionId, '你好', 'm1');
    chunk(sessionId, '，世界', 'm1');
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: '读取 README', kind: 'read', status: 'pending' });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' });
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'README 内容' } }],
    });
    update(sessionId, { sessionUpdate: 'plan', entries: [] });
    update(sessionId, { sessionUpdate: 'future_update', anything: true });
    update(sessionId, { sessionUpdate: 'future_update', anything: true });
    chunk(sessionId, '完成');
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  if (scenario === 'permission' || scenario === 'permission-other-session') {
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't2', title: '修改 App.tsx', kind: 'edit', status: 'pending' });
    const answer = await ask('session/request_permission', {
      sessionId: scenario === 'permission-other-session' ? 'someone-else' : sessionId,
      toolCall: { toolCallId: 't2' },
      options: [
        { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const outcome = answer.result?.outcome;
    const chosen = outcome?.outcome === 'selected' ? outcome.optionId : 'cancelled';
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: chosen === 'yes' ? 'completed' : 'failed' });
    chunk(sessionId, `决定：${chosen}`);
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  // W4b：原先直接拒绝的 fetch 类型交给用户；请求只带 toolCallId，标题与类型来自先前的 tool_call。
  if (scenario === 'ask' || scenario === 'ask-no-reject-once') {
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 't4',
      title: '获取 https://example.invalid/data',
      kind: 'fetch',
      status: 'pending',
    });
    const answer = await ask('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 't4' },
      options: [
        { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        ...(scenario === 'ask-no-reject-once'
          ? [{ optionId: 'never', name: 'Always reject', kind: 'reject_always' }]
          : [{ optionId: 'no', name: 'Reject', kind: 'reject_once' }]),
      ],
    });
    const outcome = answer.result?.outcome;
    const chosen = outcome?.outcome === 'selected' ? outcome.optionId : 'cancelled';
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't4', status: chosen === 'yes' ? 'completed' : 'failed' });
    chunk(sessionId, `决定：${chosen}`);
    return send({ id, result: { stopReason: cancelRequested ? 'cancelled' : 'end_turn' } });
  }
  if (scenario === 'cancel') {
    chunk(sessionId, '开始');
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't3', title: '长时间命令', kind: 'execute', status: 'in_progress' });
    const pending = ask('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 't3' },
      options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }],
    });
    // 只有收到 session/cancel 才结束：先回复权限，再发出最后的更新，然后以 cancelled 结束。
    await new Promise((resolve) => {
      cancelled = resolve;
    });
    const answer = await pending;
    chunk(sessionId, `权限：${answer.result?.outcome?.outcome}`);
    return send({ id, result: { stopReason: 'cancelled' } });
  }
  if (scenario === 'load') {
    chunk(sessionId, `已恢复 ${sessionId}`);
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  if (scenario === 'malformed') return process.stdout.write('not json\n');
  if (scenario === 'unknown-id') return send({ id: 999, result: {} });
  if (scenario === 'refusal') return send({ id, result: { stopReason: 'refusal' } });
  if (scenario === 'spurious-cancel') return send({ id, result: { stopReason: 'cancelled' } });
  if (scenario === 'other-session')
    return update('someone-else', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } });
  if (scenario === 'fs') {
    const answer = await ask('fs/read_text_file', { sessionId, path: '/etc/hostname' });
    chunk(sessionId, `fs：${answer.error?.code ?? 'allowed'}`);
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  if (scenario === 'late') {
    chunk(sessionId, '正常');
    send({ id, result: { stopReason: 'end_turn' } });
    chunk(sessionId, '迟到');
    return send({ id: 4242, result: {} });
  }
  return send({ id, error: { code: -32602, message: `unknown scenario ${scenario}` } });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (!('method' in message)) {
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
    return;
  }
  const { id, method, params } = message;
  if (method === 'initialize')
    return send({
      id,
      result: {
        protocolVersion: scenario === 'version' ? 2 : 1,
        agentCapabilities: capabilities,
        authMethods: [],
        agentInfo: { name: 'fake-acp-agent', title: 'Fake ACP Agent', version: '1.2.3' },
      },
    });
  if (method === 'session/new') return send({ id, result: { sessionId: `sess-${scenario}` } });
  if (method === 'session/load') {
    update(params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '旧问题' } });
    chunk(params.sessionId, '旧回答', 'old');
    return send({ id, result: {} });
  }
  if (method === 'session/prompt') return void prompt(id, params);
  if (method === 'session/cancel') {
    cancelRequested = true;
    return cancelled?.();
  }
  return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
});
