import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const outDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(outDir, '..', '..', '..', '..');
if (resolve(process.cwd()) !== root) {
  process.stderr.write(`run-command: 必须在本工作树根运行（${root}）\n`);
  process.exit(1);
}

const fail = (message) => {
  process.stderr.write(`run-command: ${message}\n`);
  process.exit(1);
};

const [name, command, ...args] = process.argv.slice(2);
if (!name || !command) fail('用法: node run-command.mjs <name> <command> [args...]');
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name) || name.includes('..')) fail('name 只接受安全的短文件名');

const txtPath = join(outDir, `${name}.txt`);
const metaPath = join(outDir, `${name}.meta.json`);
if (existsSync(txtPath) || existsSync(metaPath)) fail(`已存在同名证据: ${name}`);

const git = (gitArgs) => {
  const result = spawnSync('git', gitArgs, { cwd: root });
  return result.status === 0 ? result.stdout : null;
};
const head = git(['rev-parse', 'HEAD'])?.toString('utf8').trim() ?? null;
const productDiffSha256 = () => {
  const diff = git(['diff', 'HEAD', '--', 'apps/desktop/src', 'packages/protocol/src', 'e2e']);
  return diff === null ? null : createHash('sha256').update(diff).digest('hex');
};

const envOverrides = { WSL_E2E_TARGET: 'build', WSL_APP_HASH_REJECTION: '0' };
for (const key of Object.keys(process.env)) if (/^WSL_LIVE_|^WSL_.*_LIVE$/.test(key)) envOverrides[key] = '0';

const prettierOptions = { ...(await resolveConfig(metaPath)), filepath: metaPath };
const writeMeta = async (meta) => writeFileSync(metaPath, await format(JSON.stringify(meta), prettierOptions), 'utf8');

const meta = {
  name,
  command: [command, ...args],
  cwd: root,
  head,
  startedAt: new Date().toISOString(),
  endedAt: null,
  exitCode: null,
  signal: null,
  error: null,
  envOverrides,
  productSourceDiff: { sha256Before: productDiffSha256(), sha256After: null, changedDuringRun: null },
  notes: 'txt 为子进程 stdout 与 stderr 原始字节按到达顺序的交错记录，未经过 shell；meta 只记录上方 envOverrides，不转储其他环境变量。',
};

try {
  writeFileSync(metaPath, await format(JSON.stringify(meta), prettierOptions), { flag: 'wx' });
} catch (error) {
  fail(`无法创建 ${name}.meta.json: ${error instanceof Error ? (error.code ?? error.message) : error}`);
}
let fd;
try {
  fd = openSync(txtPath, 'wx');
} catch (error) {
  fail(`无法创建 ${name}.txt: ${error instanceof Error ? (error.code ?? error.message) : error}`);
}

const child = spawn(command, args, {
  cwd: root,
  env: { ...process.env, ...envOverrides },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const record = (target, chunk) => {
  target.write(chunk);
  const written = writeSync(fd, chunk);
  if (written !== chunk.length) fail(`${name}.txt 短写 ${written}/${chunk.length} 字节`);
};
child.stdout.on('data', (chunk) => record(process.stdout, chunk));
child.stderr.on('data', (chunk) => record(process.stderr, chunk));

const outcome = await new Promise((resolvePromise) => {
  child.on('error', (error) => resolvePromise({ error }));
  child.on('close', (code, signal) => resolvePromise({ code, signal }));
});
closeSync(fd);

const sha256After = productDiffSha256();
meta.endedAt = new Date().toISOString();
meta.exitCode = outcome.code ?? null;
meta.signal = outcome.signal ?? null;
meta.error = outcome.error ? String(outcome.error.message ?? outcome.error) : null;
meta.productSourceDiff = {
  sha256Before: meta.productSourceDiff.sha256Before,
  sha256After,
  changedDuringRun:
    meta.productSourceDiff.sha256Before === null || sha256After === null ? null : sha256After !== meta.productSourceDiff.sha256Before,
};
await writeMeta(meta);

if (outcome.error) process.exitCode = 1;
else if (outcome.code !== null) process.exitCode = outcome.code;
else process.exitCode = 128 + (osConstants.signals[outcome.signal] ?? 0);
