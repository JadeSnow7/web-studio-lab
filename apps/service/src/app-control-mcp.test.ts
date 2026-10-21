import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { AppToolInputSchemas } from '@wsl/protocol';

const mcpCases = [
  'AppControlMcpTests.test_app_tools_listed_only_with_turn_socket',
  'AppControlMcpTests.test_mcp_call_forwards_app_frame_and_marks_failures',
  'AppControlMcpTests.test_cli_rejects_locally_without_touching_socket',
  'AppCliTransportTests.test_channel_is_explicit_and_does_not_connect_socket',
  'AppCliTransportTests.test_main_error_exit_code_is_preserved',
  'AppCliTransportTests.test_four_slots_and_shared_capacity_budget',
  'AppCliTransportTests.test_run_budget_exhaustion_does_not_forward',
  'AppCliTransportTests.test_killed_caller_cancels_and_late_result_cannot_reach_reused_slot',
  'AppCliTransportTests.test_client_and_helper_deadlines_cancel',
  'AppCliTransportTests.test_symlink_root_and_slot_and_nonregular_lease_rejected',
  'AppCliTransportTests.test_invalid_oversized_and_non_app_frames_never_forwarded',
  'AppCliTransportTests.test_actual_helper_routing_shared_budget_and_cancellation',
  'AppCliTransportTests.test_invalid_identity_frame_and_hardlink_are_explicitly_rejected',
  'AppCliTransportTests.test_actual_helper_cleanup_failure_retains_owner_and_never_confirms_success',
];

// Keep each Python case within the existing Vitest budget and reject incomplete discovery.
it.each(mcpCases)('guest MCP / CLI transport: %s', (testCase) => {
  const source = readFileSync(new URL('./resource_mcp.py', import.meta.url), 'utf8');
  const tests = readFileSync(new URL('./app_control_mcp_tests.py', import.meta.url), 'utf8');
  const channelTests = readFileSync(new URL('./app_cli_transport_tests.py', import.meta.url), 'utf8');
  const helper = readFileSync(new URL('./guest-helper.py', import.meta.url), 'utf8');
  const python = `import types\nhelper_source=${JSON.stringify(helper)}\nmcp_source=${JSON.stringify(source)}\nmcp=types.ModuleType('wsl_resource_module')\nexec(compile(${JSON.stringify(source)},'<resource-mcp>','exec'),mcp.__dict__)\n${tests.replace("unittest.main(argv=['app-control-mcp'], exit=True, verbosity=1)", '')}\n${channelTests}
classes = {name: value for name, value in list(globals().items()) if isinstance(value, type) and issubclass(value, unittest.TestCase)}
assert sorted(classes) == ['AppCliTransportTests', 'AppControlMcpTests'], classes
discovered = [name + '.' + method for name, case in classes.items() for method in unittest.defaultTestLoader.getTestCaseNames(case)]
expected = ${JSON.stringify(mcpCases)}
assert discovered and sorted(discovered) == sorted(expected), (discovered, expected)
unittest.main(argv=['app-control-mcp', ${JSON.stringify(testCase)}], exit=True, verbosity=1)`;
  const result = spawnSync('python3', ['-I', '-'], { input: python, encoding: 'utf8', timeout: 30000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain('Ran 1 test');
  expect(result.stderr).toContain('OK');
});

it('guest helper 只为带观察能力的轮次安装 wsl-app，并对 app.* 放宽到 60 秒截止', () => {
  const helper = readFileSync(new URL('./guest-helper.py', import.meta.url), 'utf8');
  const install = helper.slice(helper.indexOf('if start.get("observation") is True:'), helper.indexOf('# TOML basic strings'));
  expect(install).toContain('env["WSL_APP_CHANNEL"] = cli_channel_path');
  expect(install).toContain('--cli');
  expect(helper).toMatch(/if request\["tool"\]\.startswith\("app\."\):\n\s+deadline \+= 40/);
});

it('Mota native MCP 参数边界与 Main 权威 schema 一致，不接受模型指定身份、路径或任意状态写入', () => {
  const source = readFileSync(new URL('./resource_mcp.py', import.meta.url), 'utf8');
  const page = { appInstanceId: 'app-1', documentGeneration: 3 };
  const cell = { appInstanceId: 'app-1', expectedSha256: 'a'.repeat(64), x: 0, y: 63 };
  const fixtures: { tool: 'app.mota.state' | 'app.mota.act' | 'app.mota.map.read' | 'app.mota.map.set'; args: unknown; valid: boolean }[] =
    [
      { tool: 'app.mota.state', args: {}, valid: true },
      { tool: 'app.mota.state', args: { runId: 'forged' }, valid: false },
      { tool: 'app.mota.state', args: { mode: 'standard' }, valid: false },
      { tool: 'app.mota.state', args: [], valid: false },
      { tool: 'app.mota.map.read', args: { appInstanceId: 'app-1' }, valid: true },
      { tool: 'app.mota.map.read', args: { appInstanceId: '' }, valid: false },
      { tool: 'app.mota.map.read', args: { appInstanceId: '😀'.repeat(101) }, valid: true },
      { tool: 'app.mota.map.read', args: { appInstanceId: '😀'.repeat(201) }, valid: false },
      { tool: 'app.mota.map.read', args: { appInstanceId: 'app-1', path: 'project/data.js' }, valid: false },
      { tool: 'app.mota.map.set', args: cell, valid: true },
      { tool: 'app.mota.map.set', args: { ...cell, expectedSha256: 'A'.repeat(64) }, valid: false },
      { tool: 'app.mota.map.set', args: { ...cell, x: true }, valid: false },
      { tool: 'app.mota.map.set', args: { ...cell, x: 0.5 }, valid: false },
      { tool: 'app.mota.map.set', args: { ...cell, y: 64 }, valid: false },
      { tool: 'app.mota.map.set', args: { ...cell, value: 999 }, valid: false },
      { tool: 'app.mota.map.set', args: { ...cell, operationId: 'owned-by-main' }, valid: false },
      { tool: 'app.mota.map.set', args: { ...cell, floorId: 'MT2' }, valid: false },
      ...[
        { action: { type: 'tile', floorId: 'MT1', x: 0, y: 63 }, valid: true },
        { action: { type: 'continue' }, valid: true },
        { action: { type: 'newGame' }, valid: true },
        { action: { type: 'key', key: 'ArrowRight' }, valid: true },
        { action: { type: 'key', key: 'X' }, valid: false },
        { action: { type: 'continue', hp: 9999 }, valid: false },
        { action: { type: 'tile', floorId: '../MT1', x: 0, y: 1 }, valid: false },
        { action: { type: 'tile', floorId: 'x'.repeat(81), x: 0, y: 1 }, valid: false },
        { action: { type: 'tile', floorId: 'MT1', x: 0, y: 1, pixelX: 50 }, valid: false },
        { action: { type: 'script', expression: 'core.status.hero.money = 9999' }, valid: false },
      ].map(({ action, valid }) => ({ tool: 'app.mota.act' as const, args: { ...page, action }, valid })),
      { tool: 'app.mota.act', args: { ...page, documentGeneration: true, action: { type: 'continue' } }, valid: false },
      {
        tool: 'app.mota.act',
        args: { ...page, documentGeneration: Number.MAX_SAFE_INTEGER + 1, action: { type: 'continue' } },
        valid: false,
      },
      { tool: 'app.mota.act', args: { ...page, resourceId: 'editor', action: { type: 'continue' } }, valid: false },
    ];
  const expected = fixtures.map(({ valid }) => valid);
  expect(fixtures.map(({ tool, args }) => AppToolInputSchemas[tool].safeParse(args).success)).toEqual(expected);
  const python = `import json, types
mcp = types.ModuleType('wsl_resource_module')
exec(compile(${JSON.stringify(source)}, '<resource-mcp>', 'exec'), mcp.__dict__)
fixtures = json.loads(${JSON.stringify(JSON.stringify(fixtures))})
results = []
for fixture in fixtures:
    try:
        mcp.validate_mota_args(fixture['tool'], fixture['args'])
        results.append(True)
    except mcp.RpcError:
        results.append(False)
print(json.dumps(results))
`;
  const result = spawnSync('python3', ['-I', '-'], { input: python, encoding: 'utf8', timeout: 10000 });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(expected);
});
