import { configDefaults, defineConfig } from 'vitest/config';

const include = ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'];
const localTerminal = 'apps/service/src/local-terminal.test.ts';

export default defineConfig({
  test: {
    include,
    environment: 'node',
    // Isolation experiment: keep PTY first, without other tests implicitly warming its runtime.
    // Preserve its existing readiness budget; the CI startup delay's cause is still undetermined.
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
