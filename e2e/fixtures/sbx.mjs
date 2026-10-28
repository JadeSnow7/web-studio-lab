#!/usr/bin/env node
// 确定性远端协议 fixture；不运行 sbx、shell 或模型。
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
// W3b relay：在本机启动 argv 指定的进程（测试中是确定性的假 ACP Agent），转发 input / input-end；不运行 guest 或模型。
let relayChild = null;
rl.on('line', (line) => {
  const value = JSON.parse(line);
  if (value.type === 'start' && value.stdin === 'relay') {
    mode = value.mode;
    if (value.mcp === 'acp-stdio')
      frame({ type: 'mcp-server', name: 'wsl_space', command: '/usr/bin/python3', args: ['-I', '-u', '-c', 'pass'] });
    // 与 guest helper 一致：Profile 配置目录只映射到声明的那一个环境变量（W4）。
    const env = value.profileDir ? { ...process.env, [value.profileDir.env]: value.profileDir.path } : process.env;
    // W4b E2E：只在测试环境变量存在时把 Claude Code 的 ACP 包装器换成确定性的假 ACP Agent。
    const scenario = process.env.WSL_FIXTURE_ACP_SCENARIO;
    const [command, ...rest] =
      scenario && value.argv[0] === 'claude-agent-acp'
        ? [process.execPath, fileURLToPath(new URL('../../apps/service/src/fixtures/fake-acp-agent.mjs', import.meta.url)), scenario]
        : value.argv;
    relayChild = spawn(command, rest, { stdio: ['pipe', 'pipe', 'pipe'], env });
    relayChild.on('error', (error) => {
      frame({ type: 'error', error: error.message });
      finish(127);
    });
    relayChild.stdout.on('data', (data) => output(data.toString()));
    relayChild.stderr.on('data', (data) => frame({ type: 'output', stream: 'stderr', data: data.toString() }));
    relayChild.on('close', (code) => finish(code ?? 1));
    frame({ type: 'ready', pid: process.pid });
    return;
  }
  if (relayChild && value.type === 'input') return void relayChild.stdin.write(value.data);
  if (relayChild && value.type === 'input-end') return void relayChild.stdin.end();
  if (relayChild && value.type === 'close') {
    relayChild.kill('SIGKILL');
    return;
  }
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
      // 与真实 CLI 一致：`codex login status` 的结果写在 stderr（2026-10-22 实测）。
      frame({ type: 'output', stream: 'stderr', data: 'Logged in fixture\n' });
      finish();
    }
    // Claude Code `auth status --json`（W4 自检）：Profile 目录名以 00000000- 开头时视为未登录，其余为已登录。
    if (value.argv.includes('auth') && value.argv.includes('status')) {
      const loggedIn = !value.profileDir?.path.split('/').at(-1).startsWith('00000000-');
      output(`${JSON.stringify({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none', email: 'fixture@example.invalid' })}\n`);
      return void finish(loggedIn ? 0 : 1);
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
