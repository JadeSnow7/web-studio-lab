import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('guest MCP socket 与命令 CLI 文件通道转发同一 app.* 帧，退出码可辨别', () => {
  const source = readFileSync(new URL('./resource_mcp.py', import.meta.url), 'utf8');
  const tests = readFileSync(new URL('./app_control_mcp_tests.py', import.meta.url), 'utf8');
  const channelTests = readFileSync(new URL('./app_cli_transport_tests.py', import.meta.url), 'utf8');
  const helper = readFileSync(new URL('./guest-helper.py', import.meta.url), 'utf8');
  const python = `import types\nhelper_source=${JSON.stringify(helper)}\nmcp_source=${JSON.stringify(source)}\nmcp=types.ModuleType('wsl_resource_module')\nexec(compile(${JSON.stringify(source)},'<resource-mcp>','exec'),mcp.__dict__)\n${tests.replace("unittest.main(argv=['app-control-mcp'], exit=True, verbosity=1)", '')}\n${channelTests}\nunittest.main(argv=['app-control-mcp'], exit=True, verbosity=1)`;
  const result = spawnSync('python3', ['-I', '-'], { input: python, encoding: 'utf8', timeout: 30000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain('OK');
});

it('guest helper 只为带观察能力的轮次安装 wsl-app，并对 app.* 放宽到 60 秒截止', () => {
  const helper = readFileSync(new URL('./guest-helper.py', import.meta.url), 'utf8');
  const install = helper.slice(helper.indexOf('if start.get("observation") is True:'), helper.indexOf('# TOML basic strings'));
  expect(install).toContain('env["WSL_APP_CHANNEL"] = cli_channel_path');
  expect(install).toContain('--cli');
  expect(helper).toMatch(/if request\["tool"\]\.startswith\("app\."\):\n\s+deadline \+= 40/);
});
