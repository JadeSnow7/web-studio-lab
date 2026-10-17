import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default function globalSetup() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  execFileSync(process.execPath, [path.join(root, 'scripts/check-e2e-deps.mjs')], { cwd: root, stdio: 'inherit' });
}
