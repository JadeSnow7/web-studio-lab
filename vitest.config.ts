import { configDefaults, defineConfig } from 'vitest/config';

const include = ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'];
const localTerminal = 'apps/service/src/local-terminal.test.ts';
const ownedNative = [
  'apps/service/src/local-terminal-detached.test.ts',
  'apps/service/src/host-python-readonly.test.ts',
  'apps/desktop/src/main/setup-adapter.test.ts',
];

export default defineConfig({
  test: {
    include,
    environment: 'node',
    // Keep PTY first, without other tests implicitly warming its selected runtime.
    // Its explicit functional wait is separate from startup performance measurements.
    projects: [
      {
        extends: false,
        test: {
          name: 'local-terminal',
          include: [localTerminal],
          environment: 'node',
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: false,
        test: {
          name: 'owned-native',
          include: ownedNative,
          environment: 'node',
          // PTY ownership scans must not overlap unrelated tests' native child processes.
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: false,
        test: {
          name: 'ordinary',
          include,
          exclude: [...configDefaults.exclude, localTerminal, ...ownedNative],
          environment: 'node',
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});
