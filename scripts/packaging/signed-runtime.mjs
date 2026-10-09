/* global process */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function verifySignedRuntime(app, run = execFileSync) {
  const verify = () => run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  verify();
  // -B forbids pyc writes inside the sealed App even when relocation invalidates cached bytecode.
  run(
    path.join(app, 'Contents/Resources/runtime/python/bin/python3'),
    [
      '-I',
      '-B',
      '-c',
      'import ssl,json,pty,os; fds=pty.openpty(); [os.close(fd) for fd in fds]; print(json.dumps({"python": "ready", "ssl": ssl.OPENSSL_VERSION, "pty": "ready"}))',
    ],
    { stdio: 'inherit' },
  );
  verify();
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (!process.argv[2] || process.argv.length !== 3) throw new Error('Usage: signed-runtime.mjs /absolute/path/App.app');
  verifySignedRuntime(path.resolve(process.argv[2]));
}
