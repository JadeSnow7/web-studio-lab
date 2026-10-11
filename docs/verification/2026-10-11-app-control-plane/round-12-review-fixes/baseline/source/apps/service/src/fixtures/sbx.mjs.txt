#!/usr/bin/env node
// 后端协议失败 fixture；不启动 guest、Codex 或 shell。
import readline from 'node:readline';
import process from 'node:process';
import console from 'node:console';
const args = process.argv.slice(2);
const kind = process.env.WSL_SBX_FIXTURE_CASE;
if (args[0] === 'inspect') {
  console.log(JSON.stringify({ name: args.at(-1), agent: 'codex', state: 'running', runtime_mounts: kind === 'mounted' ? ['/host'] : [] }));
  process.exit(0);
}
const emit = (value) => console.log('WSL_GUEST_FRAME:' + JSON.stringify(value));
const output = (data) => emit({ type: 'output', stream: 'stdout', data });
const finish = (exitCode = 0) => {
  emit({ type: 'exit', exitCode });
  if (kind !== 'missing-cleanup')
    emit({ type: 'cleanup', ok: kind !== 'cleanup-fail', ...(kind === 'cleanup-fail' ? { error: 'fixture 清理失败' } : {}) });
  process.stdout.write('', () => process.exit(0));
};
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const frame = JSON.parse(line);
  if (frame.type === 'start') {
    if (kind === 'startup-message') console.log(`Sandbox ${args[args.indexOf('-w') + 2]} started successfully`);
    if (kind === 'wrong-startup') console.log('Sandbox other started successfully');
    emit({ type: 'ready', pid: process.pid });
    if (frame.argv?.includes('--version')) {
      output('codex-cli fixture\n');
      finish(kind === 'version-fail' ? 7 : 0);
      return;
    }
    if (frame.mode === 'terminal') {
      output('fixture PTY\r\n');
      return;
    }
    if (kind === 'warnings-tools') {
      const event = (value) => output(JSON.stringify(value) + '\n');
      event({ type: 'thread.started', thread_id: 'fixture-thread' });
      event({ type: 'item.completed', item: { id: 'warning', type: 'error', message: 'MCP fixture warning' } });
      event({ type: 'item.completed', item: { id: 'warning2', type: 'error', message: 'MCP fixture warning' } });
      for (let i = 0; i < 20; i++)
        event({
          type: 'item.completed',
          item: {
            id: String(i),
            type: 'command_execution',
            command: 'cat /home/agent/workspace/fixture',
            aggregated_output: 'x'.repeat(20000),
            exit_code: 0,
          },
        });
      event({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'reply' } });
      event({ type: 'turn.completed' });
      finish();
    }
  }
  if (frame.type === 'input') output(frame.data);
  if (frame.type === 'resize') output(`${frame.rows} ${frame.cols}\r\n`);
  if (frame.type === 'close') finish();
});
input.on('close', finish);
