#!/usr/bin/env node
// Deterministic App source receipts only; no sandbox, shell or model is executed.
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args[0] === 'version') {
  console.log('sbx version: fixture');
  process.exit(0);
}
if (args[0] === 'inspect') {
  console.log(JSON.stringify({ name: args.at(-1), agent: 'codex', state: 'running', runtime_mounts: [] }));
  process.exit(0);
}
if (args[0] === 'ports') {
  console.log('[]');
  process.exit(0);
}
if (args[0] !== 'exec' || !args.includes('python3')) process.exit(8);
const dependencyRequest = args.at(-1);
if (dependencyRequest?.startsWith('{')) {
  process.stdin.resume();
  process.stdin.on('end', () => {
    console.log('WSL_APP_RESULT:{"dependenciesImported":true}');
    console.log('WSL_APP_RESULT:{"dependenciesCleanup":true}');
  });
} else {
  const frame = (value) => console.log(`WSL_GUEST_FRAME:${JSON.stringify(value)}`);
  const finish = (exitCode = 0) => {
    frame({ type: 'exit', exitCode });
    frame({ type: 'cleanup', ok: true });
    process.exit(0);
  };
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const value = JSON.parse(line);
    if (value.type === 'close') return finish();
    if (value.type !== 'start') return;
    frame({ type: 'ready', pid: process.pid });
    if (value.argv.includes('--version') || value.argv[1] === 'login') {
      frame({ type: 'output', stream: 'stdout', data: 'codex-cli fixture\n' });
      return finish();
    }
    const request = JSON.parse(value.prompt);
    if (request.operation === 'start') {
      frame({ type: 'output', stream: 'stderr', data: 'fixture: startup intentionally rejected\n' });
      return setTimeout(() => finish(7), 1200);
    }
    const result =
      request.operation === 'create'
        ? { created: true }
        : { files: [{ path: 'README.md', base64: Buffer.from('fixture source\n').toString('base64') }] };
    setTimeout(() => {
      frame({ type: 'output', stream: 'stdout', data: `WSL_APP_RESULT:${JSON.stringify(result)}\n` });
      finish();
    }, 1200);
  });
}
