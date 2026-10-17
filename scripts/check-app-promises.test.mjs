import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { ESLint } from 'eslint';

const root = path.resolve(import.meta.dirname, '..');
const filePath = path.join(root, 'apps/service/src/app-service.ts');
const eslint = new ESLint({ cwd: root, overrideConfigFile: path.join(root, 'eslint.config.js') });
const floating = '@typescript-eslint/no-floating-promises';
const misused = '@typescript-eslint/no-misused-promises';

for (const [name, source, ruleId] of [
  ['naked Promise', 'Promise.resolve();', floating],
  ['void Promise', 'void Promise.resolve();', floating],
  ['unhandled success-only chain', 'Promise.resolve().then(() => undefined);', floating],
  [
    'async success with sibling rejection handler',
    'Promise.resolve().then(async () => { await Promise.reject(new Error()); }, () => undefined);',
    'no-restricted-syntax',
  ],
  [
    'void async success with sibling rejection handler',
    'void Promise.resolve().then(async () => { await Promise.reject(new Error()); }, () => undefined);',
    'no-restricted-syntax',
  ],
  [
    'async function success with sibling rejection handler',
    'Promise.resolve().then(async function () { await Promise.reject(new Error()); }, () => undefined);',
    'no-restricted-syntax',
  ],
  [
    'async callback passed to a void function',
    'declare function subscribe(callback: () => void): void; subscribe(async () => { await Promise.resolve(); });',
    misused,
  ],
  ['async timer callback', 'setTimeout(async () => { await Promise.resolve(); }, 1);', misused],
]) {
  test(`rejects ${name}`, async () => {
    const [result] = await eslint.lintText(source, { filePath });
    assert.equal(result.fatalErrorCount, 0);
    assert.equal(result.warningCount, 0);
    assert.deepEqual(
      result.messages.map((message) => ({ ruleId: message.ruleId, severity: message.severity })),
      [{ ruleId, severity: 2 }],
    );
  });
}

for (const [name, source] of [
  ['awaited Promise', 'export async function work() { await Promise.resolve(); }'],
  ['returned Promise', 'export function work() { return Promise.resolve(); }'],
  ['terminal catch', 'Promise.resolve().catch(() => undefined);'],
  ['handled void Promise', 'void Promise.resolve().catch(() => undefined);'],
  [
    'terminal catch after both then callbacks',
    'Promise.resolve().then(async () => { await Promise.reject(new Error()); }, () => undefined).catch(() => undefined);',
  ],
  [
    'awaited chain with both then callbacks',
    'export async function work() { await Promise.resolve().then(async () => { await Promise.reject(new Error()); }, () => undefined); }',
  ],
  [
    'returned chain with both then callbacks',
    'export function work() { return Promise.resolve().then(async () => { await Promise.reject(new Error()); }, () => undefined); }',
  ],
  [
    'synchronous void callback with terminal catch',
    'declare function subscribe(callback: () => void): void; subscribe(() => { Promise.resolve().catch(() => undefined); });',
  ],
  ['synchronous timer callback with terminal catch', 'setTimeout(() => { Promise.resolve().catch(() => undefined); }, 1);'],
]) {
  test(`accepts ${name}`, async () => {
    const [result] = await eslint.lintText(source, { filePath });
    assert.deepEqual(result.messages, []);
  });
}

test('uses the service TypeScript project and rejects void escapes only in app-service.ts', async () => {
  const config = await eslint.calculateConfigForFile(filePath);
  assert.deepEqual(config.rules[floating], [2, { ignoreVoid: false }]);
  assert.deepEqual(config.rules[misused], [2]);
  assert.equal(config.languageOptions.parserOptions.project, './apps/service/tsconfig.json');
  assert.equal(config.languageOptions.parserOptions.tsconfigRootDir, root);
  for (const relative of [
    'apps/service/src/app-service.test.ts',
    'apps/service/src/guest-workspace.ts',
    'apps/desktop/src/main/preview/controller.ts',
  ]) {
    const other = await eslint.calculateConfigForFile(path.join(root, relative));
    assert.equal(other.rules[floating], undefined);
    assert.equal(other.rules[misused], undefined);
    assert.equal(other.rules['no-restricted-syntax'], undefined);
    assert.equal(other.languageOptions.parserOptions.project, undefined);
    assert.equal(await eslint.isPathIgnored(path.join(root, relative)), false);
  }
});

test('preserves existing type rules, import boundaries and the exact frozen style exception', async () => {
  const config = await eslint.calculateConfigForFile(filePath);
  assert.equal(await eslint.isPathIgnored(filePath), false);
  assert.equal(config.rules['@typescript-eslint/no-explicit-any'][0], 2);
  assert.equal(config.rules['@typescript-eslint/no-unused-vars'][0], 2);
  assert.equal(config.rules['@typescript-eslint/consistent-type-imports'][0], 2);
  assert.equal(config.rules['prefer-const'][0], 2);
  for (const relative of ['apps/desktop/src/renderer/main.tsx', 'packages/protocol/src/index.ts']) {
    const other = await eslint.calculateConfigForFile(path.join(root, relative));
    assert.equal(other.rules['no-restricted-imports'][0], 2);
  }
  const frozen = await eslint.calculateConfigForFile(path.join(root, 'tests/vertical-slice/cdp.ts'));
  assert.equal(frozen.rules['prefer-const'][0], 0);
  assert.equal(frozen.rules['@typescript-eslint/no-explicit-any'][0], 2);
  assert.equal(await eslint.isPathIgnored(path.join(root, 'tests/vertical-slice/cdp.ts')), false);
});
