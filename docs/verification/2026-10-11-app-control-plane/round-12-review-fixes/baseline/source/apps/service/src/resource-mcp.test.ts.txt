import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('./resource_mcp.py', import.meta.url), 'utf8');
const tests = readFileSync(new URL('./resource_mcp_tests.py', import.meta.url), 'utf8');
export const pythonTests = `import types\nmcp_source = ${JSON.stringify(source)}\nmcp = types.ModuleType('wsl_resource_module')\nexec(compile(mcp_source, '<resource-mcp>', 'exec'), mcp.__dict__)\n${tests}`;
describe('finite resource MCP boundary', () => {
  it('rejects cross-space, stale versions, paths, writes and malformed bundles', () => {
    const result = spawnSync('python3', ['-I', '-c', pythonTests], { encoding: 'utf8', timeout: 20000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('OK');
  });
});
