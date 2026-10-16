export const sourceSnapshotFixture = `
const sourceElectron = require('electron');
const sourceCrypto = require('node:crypto');
const sourceFixture = globalThis.__wslSourceFixture = {
  url: '', content: 'export const label = "before";\\n', unavailable: false,
  holdSnapshots: false, holdPatches: false, sourceRequests: [], patchRequests: [], sends: [],
  pendingSnapshots: new Map(), pendingPatches: [], apps: new Map(), turns: new Map(), child: null,
};
const sourceFork = sourceElectron.utilityProcess.fork.bind(sourceElectron.utilityProcess);
sourceElectron.utilityProcess.fork = (...args) => {
  const child = sourceFork(...args);
  sourceFixture.child = child;
  const post = child.postMessage.bind(child);
  const respond = (id, result) => setImmediate(() => child.emit('message', { type: 'response', id, result }));
  const fail = (id, error) => setImmediate(() => child.emit('message', { type: 'error', id, error }));
  child.postMessage = (message) => {
    const target = message.payload;
    if (message.method === 'app.create') {
      const app = { workspaceId: target.workspaceId, projectId: target.projectId, environmentId: 'sandbox', appInstanceId: null, state: 'created', url: null,
        guestCwd: '/home/agent/workspace/.wsl-apps/' + target.projectId, error: null, cleanupConfirmed: true };
      sourceFixture.apps.set(target.projectId, app);
      return respond(message.id, app);
    }
    if (message.method === 'app.get' || message.method === 'app.start' || message.method === 'app.stop') {
      const before = sourceFixture.apps.get(target.projectId);
      if (!before) return fail(message.id, 'fixture project unavailable');
      const app = message.method === 'app.start'
        ? { ...before, state: 'running', appInstanceId: sourceCrypto.randomUUID(), url: sourceFixture.url, cleanupConfirmed: false }
        : message.method === 'app.stop' ? { ...before, state: 'stopped', appInstanceId: null, url: null, cleanupConfirmed: true } : before;
      sourceFixture.apps.set(target.projectId, app);
      return respond(message.id, app);
    }
    if (message.method === 'app.source.snapshot') {
      sourceFixture.sourceRequests.push(target);
      const bytes = Buffer.from(sourceFixture.content);
      const snapshot = { ...target.target, totalBytes: bytes.length, files: [{ path: 'src/button.ts', mode: '100644', base64: bytes.toString('base64') }] };
      const deliver = () => respond(message.id, sourceFixture.unavailable
        ? { ok: false, target: target.target, cleanupConfirmed: true, error: 'fixture: unsupported source symlink' }
        : { ok: true, cleanupConfirmed: true, snapshot });
      if (sourceFixture.holdSnapshots) sourceFixture.pendingSnapshots.set(target.callId, { id: message.id, target: target.target, deliver });
      else deliver();
      return;
    }
    if (message.method === 'app.source.cancel') {
      const pending = sourceFixture.pendingSnapshots.get(target.callId);
      if (pending) { sourceFixture.pendingSnapshots.delete(target.callId); respond(pending.id, { ok: false, target: pending.target, cleanupConfirmed: true, error: 'fixture: source helper cancelled with cleanup confirmed' }); }
      return respond(message.id, null);
    }
    if (message.method === 'send') {
      sourceFixture.sends.push(target);
      const prior = sourceFixture.turns.get(target.conversationId);
      const conversation = { conversationId: target.conversationId, generation: 'source-fixture', turnId: sourceCrypto.randomUUID(),
        seq: (prior?.seq ?? 0) + 1, threadId: null, state: 'running', messages: [], toolExecutions: [], warnings: [], cleanupPending: true, error: null };
      sourceFixture.turns.set(target.conversationId, conversation);
      return respond(message.id, conversation);
    }
    if (message.method === 'cancel' && sourceFixture.turns.has(target.conversationId)) {
      const prior = sourceFixture.turns.get(target.conversationId);
      const ended = { ...prior, seq: prior.seq + 1, state: 'cancelled', cleanupPending: false };
      sourceFixture.turns.set(target.conversationId, ended);
      return respond(message.id, ended);
    }
    return post(message);
  };
  return child;
};
const sourceHandle = sourceElectron.ipcMain.handle.bind(sourceElectron.ipcMain);
sourceElectron.ipcMain.handle = (channel, listener) => sourceHandle(channel, channel !== 'workbench:run-patch' ? listener : async (...args) => {
  const result = await listener(...args);
  sourceFixture.patchRequests.push(args[1]);
  if (!sourceFixture.holdPatches) return result;
  return new Promise((resolve) => sourceFixture.pendingPatches.push(() => resolve(result)));
});
sourceFixture.releaseSnapshots = () => {
  sourceFixture.holdSnapshots = false;
  for (const { deliver } of sourceFixture.pendingSnapshots.values()) deliver();
  sourceFixture.pendingSnapshots.clear();
};
sourceFixture.releasePatches = () => {
  sourceFixture.holdPatches = false;
  for (const deliver of sourceFixture.pendingPatches.splice(0)) deliver();
};
sourceFixture.finish = (sessionId, state = 'idle', cleanupPending = false) => {
  const prior = sourceFixture.turns.get(sessionId);
  if (!prior || !sourceFixture.child) throw new Error('fixture turn missing');
  const ended = { ...prior, seq: prior.seq + 1, state, cleanupPending };
  sourceFixture.turns.set(sessionId, ended);
  sourceFixture.child.emit('message', { type: 'event', conversation: ended });
};
`;
