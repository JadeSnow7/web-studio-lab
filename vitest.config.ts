import { configDefaults, defineConfig } from 'vitest/config';

const include = ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'];
const localTerminal = 'apps/service/src/local-terminal.test.ts';

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
          name: 'ordinary',
          include,
          exclude: [...configDefaults.exclude, localTerminal],
          environment: 'node',
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
