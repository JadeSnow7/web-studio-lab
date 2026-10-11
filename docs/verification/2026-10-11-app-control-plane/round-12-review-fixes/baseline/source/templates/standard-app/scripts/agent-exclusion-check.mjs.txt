import process from 'node:process';
import console from 'node:console';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// 生产前端产物不得包含 Agent 桥接入口或注册表调试入口。用法：node scripts/agent-exclusion-check.mjs dist/client [--expect-present]
const MARKERS = ['__WSL_AGENT__', 'wsl-agent-bridge/v1', 'mountAgentBridge', 'registrySnapshot'];
const args = process.argv.slice(2);
const expectPresent = args.includes('--expect-present');
const directory = args.find((arg) => !arg.startsWith('--'));
if (!directory) throw new Error('Usage: agent-exclusion-check.mjs <dir> [--expect-present]');
async function files(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
const found = [];
const scanned = await files(directory);
if (!scanned.length) throw new Error(`No build output in ${directory}`);
for (const path of scanned) {
  const text = await readFile(path, 'latin1');
  for (const marker of MARKERS) if (text.includes(marker)) found.push({ path, marker });
}
const report = { directory, files: scanned.length, expectPresent, found };
console.log(JSON.stringify(report));
if (expectPresent ? !found.some((item) => item.marker === '__WSL_AGENT__') : found.length) process.exitCode = 1;
