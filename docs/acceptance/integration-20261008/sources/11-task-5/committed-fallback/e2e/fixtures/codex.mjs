#!/usr/bin/env node
// 确定性 CLI fixture，仅测试协议和 UI；不是模型能力证据。
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli fixture');
  process.exit(0);
}
if (args[0] === 'login') {
  console.log('Logged in fixture');
  process.exit(0);
}
if (!args.includes('--ignore-user-config') || !args.includes('--disable') || !args.includes('shell_tool') || !args.includes('hooks'))
  process.exit(8);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (text) => {
  prompt += text;
});
process.stdin.on('end', () => {
  const file = path.join(process.cwd(), 'fixture-history.json');
  const history = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  const resumed = args.includes('resume');
  if (resumed && !args.slice(args.indexOf('resume')).includes('--skip-git-repo-check')) process.exit(9);
  const thread = 'fixture-thread';
  const emit = (event) => console.log(JSON.stringify(event));
  emit({ type: 'thread.started', thread_id: thread });
  emit({ type: 'turn.started' });
  if (prompt.includes('[bad-json]')) {
    process.on('SIGTERM', () => {});
    console.log('{broken');
    setInterval(() => {}, 1000);
    return;
  }
  if (prompt.includes('[empty-reply]')) {
    emit({ type: 'turn.completed' });
    return;
  }
  if (prompt.includes('[exit]')) {
    process.stderr.write('fixture deliberate failure');
    process.exit(7);
  }
  if (prompt.includes('[slow]')) {
    process.on('SIGTERM', () => {
      setTimeout(() => process.exit(0), 150);
    });
    setInterval(() => emit({ type: 'item.completed', item: { id: 'late', type: 'agent_message', text: '迟到回复' } }), 200);
    return;
  }
  const text = prompt.includes('回忆') ? (resumed ? (history[0] ?? '没有之前内容') : '没有之前内容') : `fixture 回复：${prompt}`;
  history.push(prompt);
  fs.writeFileSync(file, JSON.stringify(history));
  emit({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text } });
  if (!prompt.includes('[no-completion]')) emit({ type: 'turn.completed', usage: {} });
});
