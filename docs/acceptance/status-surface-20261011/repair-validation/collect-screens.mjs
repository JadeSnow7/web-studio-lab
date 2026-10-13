import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const outDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(outDir, '..', '..', '..', '..');
if (resolve(process.cwd()) !== root) {
  process.stderr.write(`collect-screens: 必须在本工作树根运行（${root}）\n`);
  process.exit(1);
}

const fail = (message) => {
  process.stderr.write(`collect-screens: ${message}\n`);
  process.exit(1);
};

const [name] = process.argv.slice(2);
if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name) || name.includes('..'))
  fail('用法: node collect-screens.mjs <name>（安全的短文件名）');

const metaPath = join(outDir, `${name}.meta.json`);
if (!existsSync(metaPath)) fail(`缺少 ${name}.meta.json`);
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
if (meta.exitCode !== 0) fail(`${name}.meta.json exitCode 不是 0`);
if (meta.productSourceDiff?.changedDuringRun !== false) fail(`${name}.meta.json productSourceDiff.changedDuringRun 不是 false`);
const startedAt = Date.parse(meta.startedAt);
const endedAt = Date.parse(meta.endedAt);
if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) fail('meta startedAt/endedAt 无效');

const expected = [
  'combo-ai-loaderror-blockednav-1440',
  'combo-ai-loaderror-blockednav-960',
  'combo-paused-detached-1440',
  'combo-paused-detached-960',
  'combo-problem-more-1440',
  'combo-problem-more-960',
  'files-unavailable-no-env-1440',
  'files-unavailable-reason-1440',
  'files-observation-history-1440',
  'terminal-cleanup-pending-disabled-1440',
  'debug-panel-live-update-1440',
];

const sourceDir = join(root, 'test-results', 'screens', 'build', 'status-surface');
const targetDir = join(outDir, 'screens', name);
mkdirSync(dirname(targetDir), { recursive: true });
try {
  mkdirSync(targetDir);
} catch (error) {
  fail(`目标目录须独占新建: ${targetDir}（${error instanceof Error ? (error.code ?? error.message) : error}）`);
}

const files = [];
for (const base of expected) {
  const file = `${base}.png`;
  const source = join(sourceDir, file);
  if (!existsSync(source)) fail(`缺少本轮新增截图: ${relative(root, source)}`);
  const stat = statSync(source);
  if (stat.mtimeMs < startedAt - 1000 || stat.mtimeMs > endedAt + 1000)
    fail(`${file} mtime ${stat.mtime.toISOString()} 不在 ${meta.startedAt} ~ ${meta.endedAt} 时段内（含 1s 余量），疑似旧图`);
  const buffer = readFileSync(source);
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47 || buffer.toString('ascii', 12, 16) !== 'IHDR')
    fail(`${file} 不是有效 PNG`);
  const target = join(targetDir, file);
  writeFileSync(target, buffer, { flag: 'wx' });
  files.push({
    file,
    source: relative(root, source),
    target: relative(root, target),
    sha256: createHash('sha256').update(buffer).digest('hex'),
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bytes: buffer.length,
    mtime: stat.mtime.toISOString(),
  });
}
if (files.length !== 11) fail(`收集 ${files.length} 张，要求恰好 11 张`);

const manifestPath = join(outDir, `${name}-screens.json`);
const manifest = {
  runName: name,
  meta: `${name}.meta.json`,
  productSourceDiff: meta.productSourceDiff,
  window: { startedAt: meta.startedAt, endedAt: meta.endedAt },
  count: files.length,
  files,
  note: 'PNG只能证明静态画面；键盘焦点到达、方向键移动、原生网页让位/恢复、禁用与命令参数由正式E2E断言证明。',
};
try {
  writeFileSync(manifestPath, await format(JSON.stringify(manifest), { ...(await resolveConfig(manifestPath)), filepath: manifestPath }), {
    flag: 'wx',
  });
} catch (error) {
  fail(`无法创建 ${name}-screens.json: ${error instanceof Error ? (error.code ?? error.message) : error}`);
}
process.stdout.write(`${files.length} ${name}-screens.json\n`);
