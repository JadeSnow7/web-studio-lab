import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { it, expect } from 'vitest';
it('uses a real Unix socket for bounded observation calls and releases its own client/server paths', () => {
  const source = readFileSync(new URL('./resource_mcp.py', import.meta.url), 'utf8');
  const helper = readFileSync(new URL('./guest-helper.py', import.meta.url), 'utf8');
  const tests = readFileSync(new URL('./observation_mcp_tests.py', import.meta.url), 'utf8');
  const python = `import types\nmcp=types.ModuleType('wsl_resource_module')\nexec(compile(${JSON.stringify(source)},'<resource-mcp>','exec'),mcp.__dict__)\nhelper_source=${JSON.stringify(helper)}\n${tests}`;
  const result = spawnSync('python3', ['-I', '-c', python], { encoding: 'utf8', timeout: 20000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain('OK');
});
