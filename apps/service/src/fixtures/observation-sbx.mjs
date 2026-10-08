#!/usr/bin/env node
// Framed service fixture; no model, sandbox, or shell is started.
import process from 'node:process';
import console from 'node:console';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
if (process.argv[2] === 'inspect') {
  console.log(JSON.stringify({ name: process.argv.at(-1), agent: 'codex', state: 'running', runtime_mounts: [] }));
  process.exit(0);
}
const emit = (value) => console.log('WSL_GUEST_FRAME:' + JSON.stringify(value));
const finish = () => {
  emit({ type: 'exit', exitCode: 0 });
  emit({ type: 'cleanup', ok: true });
  process.exit(0);
};
const rl = readline.createInterface({ input: process.stdin });
let mode = '';
let calls = [];
let replies = 0;
rl.on('line', (line) => {
  const frame = JSON.parse(line);
  if (frame.type === 'start') {
    emit({ type: 'ready', pid: process.pid });
    if (frame.argv.includes('--version')) {
      emit({ type: 'output', stream: 'stdout', data: 'codex-cli fixture\n' });
      finish();
      return;
    }
    mode = frame.prompt;
    emit({ type: 'output', stream: 'stdout', data: '{"type":"thread.started","thread_id":"fixture-observe"}\n' });
    if (!frame.observation) {
      finish();
      return;
    }
    const count = mode === 'concurrent' ? 5 : 1;
    for (let index = 0; index < count; index++) {
      const id = randomUUID();
      calls.push(id);
      emit({ type: 'observation-call', id, tool: 'files.read', args: { resourceId: 'resource-a', path: 'note.txt' } });
    }
    if (mode === 'disconnect') emit({ type: 'observation-cancel', id: calls[0] });
  }
  if (frame.type === 'observation-result') {
    replies++;
    if (mode === 'budget' && replies < 65) {
      const id = randomUUID();
      calls.push(id);
      emit({ type: 'observation-call', id, tool: 'files.read', args: { resourceId: 'resource-a', path: 'note.txt' } });
    }
    emit({
      type: 'output',
      stream: 'stdout',
      data:
        JSON.stringify({
          type: 'item.completed',
          item: { id: String(replies), type: 'agent_message', text: JSON.stringify(frame.result) },
        }) + '\n',
    });
    if (mode === 'single' || mode === 'large' || mode === 'disconnect' || (mode === 'budget' && replies === 65)) {
      emit({ type: 'output', stream: 'stdout', data: '{"type":"turn.completed"}\n' });
      finish();
    }
  }
  if (frame.type === 'close') finish();
});
