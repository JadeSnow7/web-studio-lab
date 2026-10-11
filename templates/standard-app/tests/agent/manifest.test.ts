import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkManifest, generateManifest, scanSource, writeManifest } from '../../server/agent/manifest.js';
import { describeRevision } from '../../server/agent/describe.js';

const template = resolve('.');

/** 复制一份项目源码（不含依赖与构建产物），node_modules 以符号链接共享。 */
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'wsl-agent-project-'));
  await cp(template, root, {
    recursive: true,
    filter: (source) => !/[\\/](node_modules|dist|\.data|\.test-data)([\\/]|$)/.test(source.slice(template.length)),
  });
  await symlink(join(template, 'node_modules'), join(root, 'node_modules'), 'dir');
  return root;
}

test('模板自带的 manifest 与当前源码一致，并导出路由、数据模型、命令 schema、状态和 testid', async () => {
  const result = await checkManifest(template);
  assert.deepEqual(result.failures, []);
  const { manifest } = await generateManifest(template);
  assert.deepEqual(
    manifest.routes.map((route) => `${route.method} ${route.path}`),
    ['POST /api/dev/session', 'GET /api/health', 'GET /api/kv/:key', 'PUT /api/kv/:key'],
  );
  assert.deepEqual(
    manifest.dataModel.map((table) => table.table),
    ['records', 'sessions'],
  );
  assert.deepEqual(manifest.dataModel[0]?.primaryKey, ['user_id', 'key']);
  assert.equal(manifest.commands[0]?.name, 'health.refresh');
  assert.equal(manifest.commands[0]?.inputSchema.type, 'object');
  assert.deepEqual(
    manifest.states.map((state) => state.name),
    ['app.health'],
  );
  assert.deepEqual(manifest.pages[0]?.testids, ['app-instance-id', 'health-refresh', 'health-status', 'project-id']);
  assert.ok(!JSON.stringify(manifest).includes('__agent'), '控制面端点不进入 manifest 路由');
});

test('manifest --check：缺 testid、命令缺 schema、注册名重复与过期 manifest 都失败', async () => {
  const root = await project();
  try {
    assert.equal((await checkManifest(root)).ok, true);
    const app = join(root, 'src/App.tsx');
    const original = await readFile(app, 'utf8');
    await writeFile(
      app,
      original.replace(
        '<p className="mt-6',
        `<button type="button" onClick={() => undefined}>无标识</button>
      <div onClick={() => undefined}>可点击</div>
      <input type="hidden" name="ignored" />
      <p className="mt-6`,
      ),
    );
    const extra = join(root, 'src/Extra.tsx');
    await writeFile(
      extra,
      `import { useAgentCommand, useAgentState } from './agent/registry';
export function Extra() {
  useAgentState('app.health', 1);
  useAgentCommand('missing.command' as never, () => null);
  return null;
}
`,
    );
    const result = await checkManifest(root);
    assert.equal(result.ok, false);
    const codes = result.failures.map((failure) => `${failure.code}@${failure.source.split(':')[0]}`);
    assert.equal(codes.filter((code) => code === 'missing_testid@src/App.tsx').length, 2, '按钮与带 onClick 的 div；隐藏 input 不计');
    assert.ok(codes.includes('duplicate_registration@src/App.tsx'));
    assert.ok(codes.includes('command_without_schema@src/Extra.tsx'));
    assert.ok(codes.includes('manifest_stale@agent/app.manifest.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('修订：改源码后 manifest 与构建都过期；重建 manifest 后仅构建过期；写入构建戳后恢复', async () => {
  const root = await project();
  try {
    await writeManifest(root, { buildStamp: true });
    let revision = await describeRevision(root);
    assert.deepEqual(revision.stale, { manifest: false, build: false });
    await writeFile(join(root, 'src/components/Button.tsx'), (await readFile(join(root, 'src/components/Button.tsx'), 'utf8')) + '\n');
    revision = await describeRevision(root);
    assert.deepEqual(revision.stale, { manifest: true, build: true });
    await writeManifest(root);
    revision = await describeRevision(root);
    assert.deepEqual(revision.stale, { manifest: false, build: true });
    await writeManifest(root, { buildStamp: true });
    assert.deepEqual((await describeRevision(root)).stale, { manifest: false, build: false });
    // 生成物、依赖与数据目录不改变源码修订。
    await writeFile(join(root, 'agent/notes.txt'), 'x');
    await writeFile(join(root, 'server.log'), 'x');
    assert.deepEqual((await describeRevision(root)).stale, { manifest: false, build: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('JSX 扫描：非字面量 testid 与注册名被报告，透传 props 的封装组件不要求 testid', () => {
  const scanned = scanSource(
    'src/X.tsx',
    `export const A = (props: object) => <button {...props} />;
export const B = ({ id }: { id: string }) => <a href="#" data-testid={id}>x</a>;
export const C = () => { exposeState(name, () => 1); return <select data-testid="s" />; };
declare const name: string; declare function exposeState(n: string, g: () => unknown): void;`,
  );
  assert.deepEqual(
    scanned.checks.map((check) => check.code),
    ['dynamic_testid'],
  );
  assert.deepEqual(scanned.stateSites, [{ name: null, source: 'src/X.tsx:3' }]);
  assert.deepEqual(
    scanned.testids.map((item) => item.testid),
    ['s'],
  );
});
