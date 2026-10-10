import { setTimeout } from 'node:timers';
import process from 'node:process';
import console from 'node:console';
import { spawn } from 'node:child_process';
const children = [
  spawn(process.execPath, ['--import', 'tsx', '--watch', 'server/index.ts'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
];
let closing = false;
function stop(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill('SIGTERM');
  Promise.all(
    children.map((child) =>
      child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve)),
    ),
  ).then(() => process.exit(code));
  setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
    process.exit(1);
  }, 10000).unref();
}
for (const child of children) {
  child.on('error', (error) => {
    console.error(error);
    stop(1);
  });
  child.on('exit', (code) => stop(code ?? 1));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
