import { configDefaults, defineConfig } from 'vitest/config';

const include = ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'];
const observation = 'apps/desktop/src/main/workbench/observation-application.test.ts';
const mcp = 'apps/service/src/app-control-mcp.test.ts';
const localTerminal = 'apps/service/src/local-terminal.test.ts';
const motaServer = 'apps/service/src/mota-server.test.ts';

export default defineConfig({
  test: {
    include,
    environment: 'node',
    // Isolate sequential observations, MCP Python fanout and local PTY startup from ordinary suite contention.
    projects: [
      {
        extends: false,
        test: {
          name: 'ordinary',
          include,
          exclude: [...configDefaults.exclude, observation, mcp, localTerminal, motaServer],
          environment: 'node',
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: false,
        test: {
          name: 'observation',
          include: [observation],
          environment: 'node',
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: false,
        test: {
          name: 'app-control-mcp',
          include: [mcp],
          environment: 'node',
          sequence: { groupOrder: 2 },
        },
      },
      {
        extends: false,
        test: {
          name: 'local-terminal',
          include: [localTerminal],
          environment: 'node',
          sequence: { groupOrder: 3 },
        },
      },
      {
        extends: false,
        test: {
          name: 'mota-server',
          include: [motaServer],
          environment: 'node',
          sequence: { groupOrder: 4 },
        },
      },
    ],
  },
});
