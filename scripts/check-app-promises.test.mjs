import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { after, test } from 'node:test';
import { ESLint } from 'eslint';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const filePath = path.join(root, 'apps/service/src/app-service.ts');
const eslint = new ESLint({ cwd: root, overrideConfigFile: path.join(root, 'eslint.config.js') });
const floating = '@typescript-eslint/no-floating-promises';
const misused = '@typescript-eslint/no-misused-promises';

const rejectedCases = [
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
];

const acceptedCases = [
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
];

// CI single-run parsing treats repeated lintText calls for one path as a fix loop.
// Give every unchanged snippet its own disk file and lint the complete set once.
async function prepareFixtures() {
  mkdirSync(path.join(root, '.local'), { recursive: true });
  const fixtureRoot = mkdtempSync(path.join(root, '.local/app-promises-'));
  try {
    const cases = [...rejectedCases, ...acceptedCases];
    const fixturePaths = cases.map(([, source], index) => {
      const file = path.join(fixtureRoot, `case-${index}.ts`);
      writeFileSync(file, source);
      return file;
    });
    const fixtureProject = path.join(fixtureRoot, 'tsconfig.json');
    writeFileSync(
      fixtureProject,
      JSON.stringify({
        extends: path.join(root, 'apps/service/tsconfig.json'),
        compilerOptions: { moduleDetection: 'force' },
        include: ['*.ts'],
      }),
    );
    const productionConfig = await eslint.calculateConfigForFile(filePath);
    const productionParser = productionConfig.languageOptions.parser;
    const observations = new Map();
    const observedParser = {
      ...productionParser,
      parseForESLint(source, options) {
        const parsed = productionParser.parseForESLint(source, options);
        const { program, esTreeNodeToTSNodeMap } = parsed.services;
        const programSource = program.getSourceFile(options.filePath);
        const checker = program.getTypeChecker();
        const calls = [];
        const visit = (node) => {
          if (!node || typeof node !== 'object') return;
          if (
            node.type === 'CallExpression' &&
            node.callee.type === 'MemberExpression' &&
            node.callee.object.name === 'Promise' &&
            node.callee.property.name === 'resolve'
          ) {
            const mapped = esTreeNodeToTSNodeMap.get(node);
            const type = checker.getTypeAtLocation(mapped);
            const then = checker.getPropertyOfType(type, 'then');
            const thenType = then && checker.getTypeOfSymbolAtLocation(then, mapped);
            calls.push({
              mappedSource: mapped.getSourceFile().text,
              belongsToProgramSource: mapped.getSourceFile() === programSource,
              type: checker.typeToString(type),
              isAny: Boolean(type.flags & ts.TypeFlags.Any),
              thenSignatures: thenType ? checker.getSignaturesOfType(thenType, ts.SignatureKind.Call).length : 0,
              thenFromLibrary: then
                ?.getDeclarations()
                ?.some((declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile())),
            });
          }
          for (const [key, value] of Object.entries(node)) {
            if (['parent', 'loc', 'range', 'tokens', 'comments'].includes(key)) continue;
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object') visit(value);
          }
        };
        visit(parsed.ast);
        observations.set(options.filePath, {
          input: source,
          programSource: programSource.text,
          noResolve: program.getCompilerOptions().noResolve,
          calls,
        });
        return parsed;
      },
    };
    const fixtureEslint = new ESLint({
      cwd: fixtureRoot,
      overrideConfigFile: true,
      overrideConfig: [
        {
          // Resolved Config.language is an object, not a flat-config input value.
          rules: productionConfig.rules,
          plugins: productionConfig.plugins,
          linterOptions: productionConfig.linterOptions,
          files: ['*.ts'],
          languageOptions: {
            ...productionConfig.languageOptions,
            parser: observedParser,
            parserOptions: { ...productionConfig.languageOptions.parserOptions, project: fixtureProject },
          },
        },
      ],
    });
    const results = new Map((await fixtureEslint.lintFiles(fixturePaths)).map((result) => [result.filePath, result]));
    return { fixtureRoot, cases, fixturePaths, fixtureProject, productionConfig, observations, fixtureEslint, results };
  } catch (error) {
    try {
      rmSync(fixtureRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Promise lint fixture setup and cleanup failed', { cause: cleanupError });
    }
    throw error;
  }
}
const { fixtureRoot, cases, fixturePaths, fixtureProject, productionConfig, observations, fixtureEslint, results } =
  await prepareFixtures();
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

for (const [index, [name, , ruleId]] of rejectedCases.entries()) {
  test(`rejects ${name}`, () => {
    const result = results.get(fixturePaths[index]);
    assert.equal(result.fatalErrorCount, 0);
    assert.equal(result.warningCount, 0);
    assert.deepEqual(
      result.messages.map((message) => ({ ruleId: message.ruleId, severity: message.severity })),
      [{ ruleId, severity: 2 }],
    );
  });
}

for (const [index, [name]] of acceptedCases.entries()) {
  test(`accepts ${name}`, () => {
    const result = results.get(fixturePaths[rejectedCases.length + index]);
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

test('lints every disk snippet with its actual Program text, mapped nodes and library Promise types', async () => {
  assert.equal(results.size, cases.length);
  assert.equal(observations.size, cases.length);
  for (const [index, [, source]] of cases.entries()) {
    const observation = observations.get(fixturePaths[index]);
    assert.equal(observation.input, source);
    assert.equal(observation.programSource, source);
    assert.notEqual(observation.noResolve, true);
    assert.ok(observation.calls.length > 0);
    for (const call of observation.calls) {
      assert.equal(call.mappedSource, source);
      assert.equal(call.belongsToProgramSource, true);
      assert.equal(call.isAny, false);
      assert.match(call.type, /^Promise</);
      assert.ok(call.thenSignatures > 0);
      assert.equal(call.thenFromLibrary, true);
    }
    const config = await fixtureEslint.calculateConfigForFile(fixturePaths[index]);
    assert.deepEqual(config.rules, productionConfig.rules);
    assert.equal(config.language, productionConfig.language);
    assert.equal(config.processor, productionConfig.processor);
    assert.deepEqual(config.settings, productionConfig.settings);
    assert.deepEqual(config.languageOptions.parserOptions, {
      ...productionConfig.languageOptions.parserOptions,
      project: fixtureProject,
    });
  }
});

test('the unchanged production config rejects real relative app-service.ts disk input through ESLint CLI', () => {
  const directory = path.join(fixtureRoot, 'production-scope');
  const relative = 'apps/service/src/app-service.ts';
  mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
  for (const file of ['eslint.config.js', 'tsconfig.base.json', 'apps/service/tsconfig.json', 'package.json']) {
    writeFileSync(path.join(directory, file), readFileSync(path.join(root, file)));
  }
  symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'junction');
  const source = [rejectedCases[0][1], rejectedCases[6][1], rejectedCases[3][1]].join('\n');
  writeFileSync(path.join(directory, relative), source);
  const cli = spawnSync(process.execPath, [path.join(root, 'node_modules/eslint/bin/eslint.js'), relative, '--format', 'json'], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(cli.error, undefined);
  assert.equal(cli.signal, null);
  assert.equal(cli.status, 1, cli.stderr);
  const [result] = JSON.parse(cli.stdout);
  assert.equal(result.fatalErrorCount, 0);
  assert.equal(result.warningCount, 0);
  assert.deepEqual(
    result.messages.map((message) => ({ ruleId: message.ruleId, severity: message.severity })),
    [floating, misused, 'no-restricted-syntax'].map((ruleId) => ({ ruleId, severity: 2 })),
  );
});
