#!/usr/bin/env node
// 确定性远端协议 fixture；不运行 sbx、shell 或模型。
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === 'version') {
  console.log('sbx version: fixture');
  process.exit(0);
}
if (args[0] === 'inspect') {
  console.log(JSON.stringify({ name: args.at(-1), agent: 'codex', state: 'running', runtime_mounts: [] }));
  process.exit(0);
}
if (args[0] !== 'exec' || !args.includes('python3')) process.exit(8);
const frame = (value) => console.log(`WSL_GUEST_FRAME:${JSON.stringify(value)}`);
const output = (data) => frame({ type: 'output', stream: 'stdout', data });
const finish = (exitCode = 0) => {
  frame({ type: 'exit', exitCode });
  frame({ type: 'cleanup', ok: true });
  process.exit(0);
};
const rl = readline.createInterface({ input: process.stdin });
let mode;
let input = '';
let cwd = '/home/agent/workspace';
let size;
rl.on('line', (line) => {
  const value = JSON.parse(line);
  if (value.type === 'start') {
    mode = value.mode;
    frame({ type: 'ready', pid: process.pid });
    if (mode === 'terminal') {
      size = `${value.rows} ${value.cols}`;
      output('fixture shell\r\n$ ');
      return;
    }
    if (value.argv.includes('--version')) {
      output('codex-cli fixture\n');
      finish();
    }
    if (value.argv[1] === 'login') {
      output('Logged in fixture\n');
      finish();
    }
    if (value.argv.includes('--ignore-user-config') || value.argv.includes('shell_tool')) finish(8);
    const prompt = value.prompt;
    const emit = (event) => output(`${JSON.stringify(event)}\n`);
    const resumed = value.argv.includes('resume');
    const thread = resumed ? value.argv.at(-2) : `fixture-${randomUUID()}`;
    emit({ type: 'thread.started', thread_id: thread });
    emit({ type: 'turn.started' });
    if (prompt.includes('[slow]')) {
      setInterval(() => emit({ type: 'item.completed', item: { id: 'late', type: 'agent_message', text: '迟到回复' } }), 200);
      return;
    }
    if (prompt.includes('[cleanup-fail]')) {
      frame({ type: 'exit', exitCode: 0 });
      frame({ type: 'cleanup', ok: false, error: 'fixture 清理失败' });
      process.exit(0);
    }
    if (prompt.includes('[missing-cleanup]')) {
      frame({ type: 'exit', exitCode: 0 });
      process.exit(0);
    }
    if (prompt.includes('[empty-reply]')) {
      emit({ type: 'turn.completed' });
      finish();
    }
    if (prompt.includes('[bad-json]')) {
      output('{broken\n');
      return;
    }
    if (prompt.includes('[exit]')) {
      finish(7);
      return;
    }
    const historyFile = path.join(tmpdir(), `${thread}.json`);
    const history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8')) : [];
    const text = prompt.includes('回忆') ? (resumed ? (history[0] ?? '没有之前内容') : '没有之前内容') : `fixture 回复：${prompt}`;
    history.push(prompt);
    fs.writeFileSync(historyFile, JSON.stringify(history));
    emit({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text } });
    if (!prompt.includes('[no-completion]')) emit({ type: 'turn.completed' });
    finish();
  } else if (value.type === 'close') finish();
  else if (value.type === 'resize') size = `${value.rows} ${value.cols}`;
  else if (value.type === 'input') {
    if (value.data.includes('\u0003')) {
      input = '';
      output('^C\r\n$ ');
      return;
    }
    input += value.data;
    while (input.includes('\r') || input.includes('\n')) {
      const index = input.search(/[\r\n]/);
      const command = input.slice(0, index);
      input = input.slice(index + 1);
      output(`${command}\r\n`);
      if (command.startsWith('cd ')) cwd = command.slice(3);
      else if (command === 'pwd') output(`${cwd}\r\n`);
      else if (command === 'uname -s') output('Linux\r\n');
      else if (command === 'node --version') output('v24.fixture\r\n');
      else if (command === 'codex --version') output('codex-cli fixture\r\n');
      else if (command === 'stty size') output(`${size}\r\n`);
      else if (command === 'exit') finish();
      else if (command.startsWith('printf ')) output('TERMINAL_MARKER\r\n');
      if (command !== 'sleep 60') output('$ ');
    }
  }
});
rl.on('close', () => finish());
