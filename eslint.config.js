// @ts-check
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/release/**',
      '.local/**',
      'playwright-report/**',
      'test-results/**',
      'demo/**',
      'docs/design/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } } },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // 主进程、preload、构建配置与测试运行在 Node 中。
    files: [
      'apps/service/**/*.ts',
      'apps/desktop/src/main/**/*.ts',
      'apps/desktop/src/preload/**/*.ts',
      'apps/desktop/*.ts',
      'e2e/**/*.{ts,js,mjs}',
      'scripts/check-docs.mjs',
      '*.ts',
      '*.js',
    ],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // renderer 不使用 Node 或 Electron API（架构约束第 3 节）。
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['electron', 'electron/*'], message: 'renderer 不能使用 Electron API，请通过 window.studio。' },
            { group: ['node:*'], message: 'renderer 不能使用 Node API。' },
            { group: ['fs', 'path', 'child_process', 'os', 'crypto'], message: 'renderer 不能使用 Node API。' },
            { group: ['**/main/**', '**/preload/**'], message: 'renderer 不能 import 主进程或 preload 代码。' },
          ],
        },
      ],
    },
  },
  {
    // 受管 App 的类型差异只在 app-kinds/ 声明，service 其余代码不按 projectKind 分支。
    // app-imports.ts 暂例外：导入请求在 protocol 中只携带 edu 来源，泛化导入属于后续步骤。
    files: ['apps/service/src/**/*.ts'],
    ignores: ['apps/service/src/app-kinds/**', 'apps/service/src/app-imports.ts', '**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "BinaryExpression MemberExpression[property.name='projectKind']",
          message: '按 projectKind 分支的行为请声明在 apps/service/src/app-kinds/ 的类型策略中。',
        },
        {
          selector: "SwitchStatement > MemberExpression.discriminant[property.name='projectKind']",
          message: '按 projectKind 分支的行为请声明在 apps/service/src/app-kinds/ 的类型策略中。',
        },
      ],
    },
  },
  {
    // protocol 只依赖 zod。
    files: ['packages/protocol/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['electron', 'node:*', 'react', '@wsl/*'], message: 'protocol 只依赖 zod。' }] },
      ],
    },
  },
);
