import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  AppAuditRecordSchema,
  AppControlResultSchema,
  AppToolInputSchemas,
  AppToolNameSchema,
  type WorkbenchCommand,
} from '../packages/protocol/src';
import { launchApp, workspaceSnapshot, workshopNavigate } from './helpers';

const execute = promisify(execFile);
const sbx = process.env['WSL_SBX_BIN'] ?? '/opt/homebrew/bin/sbx';
const sandbox = process.env['WSL_SBX_NAME'] ?? 'wsl-sbx-smoke-20261006';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const CallSchema = z.object({
  id: z.uuid(),
  runId: z.string(),
  tool: AppToolNameSchema,
  args: z.record(z.string(), z.unknown()),
  at: z.number(),
});
const GateSchema = z.object({
  target: CallSchema.nullable(),
  second: CallSchema.nullable(),
  held: z.object({ id: z.uuid(), result: AppControlResultSchema, at: z.number() }).nullable(),
  calls: z.array(z.object({ id: z.uuid(), runId: z.string(), tool: AppToolNameSchema, at: z.number(), actionType: z.string().nullable() })),
  events: z.array(z.object({ type: z.string(), at: z.number(), reason: z.string().optional(), callId: z.string().optional() })),
});
type GateGlobal = typeof globalThis & {
  __wslAppCancelGate: z.infer<typeof GateSchema> & {
    nonce: string | null;
    releaseOnSecond: boolean;
    release(reason: string): boolean;
  };
};
const IdentitySchema = z.object({ pid: z.number().int(), ppid: z.number().int(), starttime: z.string(), comm: z.string() });
const SourceHashesSchema = z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/));
const OwnershipSchema = z.object({
  cli: IdentitySchema,
  helper: IdentitySchema,
  ancestors: z.array(IdentitySchema),
  tree: z.array(IdentitySchema),
  channel: z.string().regex(/^\/tmp\/wsl-observe-[^/]+\/app-channel$/),
  lease: z.object({ path: z.string(), held: z.literal(true), mode: z.literal(384) }),
  sourceHashes: SourceHashesSchema,
  markers: z.object({ retained: z.string().nullable(), forbidden: z.string().nullable() }),
});
const PortsSchema = z.array(z.object({ host_ip: z.string(), host_port: z.number(), sandbox_port: z.number(), protocol: z.string() }));
const portKey = (port: z.infer<typeof PortsSchema>[number]) => `${port.protocol}:${port.host_ip}:${port.host_port}:${port.sandbox_port}`;

const sourceHashFunction = `import pathlib,hashlib,os
def source_hashes(cwd):
 p=pathlib.Path(cwd); out={}; total=0
 if p.parent!=pathlib.Path('/home/agent/workspace/.wsl-apps') or p.is_symlink(): raise ValueError('unowned project')
 for parent,dirs,files in os.walk(p,followlinks=False):
  dirs[:]=sorted(d for d in dirs if d not in {'node_modules','dist','.data','data','.git','.vite'})
  for name in sorted(files):
   f=pathlib.Path(parent)/name; rel=f.relative_to(p).as_posix()
   if name.startswith('.wsl-'): continue
   if f.is_symlink(): raise ValueError('source symlink')
   b=f.read_bytes();total+=len(b)
   if total>8388608 or len(out)>=256: raise ValueError('source budget exceeded')
   out[rel]=hashlib.sha256(b).hexdigest()
 return out`;

// Read process identities and file descriptor targets only; never read /proc/*/environ or persist command lines.
const ownershipScript = `${sourceHashFunction}
import pathlib,json,sys,re,fcntl,os
nonce=sys.argv[1]; processes={}; cli=[]
def info(p):
 s=(p/'stat').read_text().rsplit(')',1)[1].split()
 return {'pid':int(p.name),'ppid':int(s[1]),'starttime':s[19],'comm':(p/'comm').read_text().strip()}
def fds(pid):
 out=[]
 for f in (pathlib.Path('/proc')/str(pid)/'fd').iterdir():
  try: out.append(os.readlink(f))
  except FileNotFoundError: pass
 return out
for p in pathlib.Path('/proc').glob('[0-9]*'):
 try:
  i=info(p); processes[i['pid']]=i
  args=(p/'cmdline').read_bytes().split(bytes([0]))
  if b'--cli' in args and any(nonce.encode() in a for a in args): cli.append(i)
 except (FileNotFoundError,ProcessLookupError): pass
if len(cli)!=1: raise ValueError('Expected one live nonce-bound CLI process')
c=cli[0]; targets=fds(c['pid']); lease=next(t for t in targets if re.fullmatch('/tmp/wsl-observe-[^/]+/app-channel/[0-3]/lease',t))
channel=str(pathlib.Path(lease).parent.parent); ancestors=[]; current=c
for _ in range(32):
 ancestors.append(current)
 if current['pid']!=c['pid'] and sum(t.startswith(channel+'/') and t.endswith('/lease') for t in fds(current['pid']))==4:
  helper=current; break
 current=processes[current['ppid']]
else: raise ValueError('CLI helper ancestor with four owned lease descriptors not found')
owned={helper['pid']}
while True:
 added={pid for pid,i in processes.items() if i['ppid'] in owned}-owned
 if not added: break
 owned.update(added)
with open(lease,'rb') as lock:
 try:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError: held=True
 else:
  fcntl.flock(lock,fcntl.LOCK_UN); held=False
 mode=os.fstat(lock.fileno()).st_mode & 511
print(json.dumps({'cli':c,'helper':helper,'ancestors':ancestors,'tree':[processes[p] for p in sorted(owned)],'channel':channel,'lease':{'path':lease,'held':held,'mode':mode},'sourceHashes':source_hashes(sys.argv[2]),'markers':{k:(pathlib.Path(sys.argv[2])/f).read_text() if (pathlib.Path(sys.argv[2])/f).exists() else None for k,f in [('retained',sys.argv[3]),('forbidden',sys.argv[4])]}}))`;
const stoppedScript = `import pathlib,json,sys
owned=json.loads(sys.argv[1]); remaining=[]
for i in owned['tree']:
 p=pathlib.Path('/proc')/str(i['pid'])
 try:
  start=(p/'stat').read_text().rsplit(')',1)[1].split()[19]
  if start==i['starttime']: remaining.append(i)
 except FileNotFoundError: pass
print(json.dumps({'remaining':remaining,'channelExists':pathlib.Path(owned['channel']).exists()}))`;
async function guest(args: string[]) {
  return execute(sbx, ['exec', sandbox, ...args], { timeout: 30_000, maxBuffer: 1024 * 1024 });
}

test('real CLI cancellation stops owned processes and isolates a delayed reply from the next run', async () => {
  test.skip(process.env['WSL_APP_CONTROL_CANCEL_LIVE'] !== '1', 'explicit real model AND sandbox authorization required');
  test.setTimeout(900_000);
  const evidence = path.resolve(process.env['WSL_APP_CONTROL_CANCEL_EVIDENCE'] ?? 'test-results/app-control-cancel-live/' + randomUUID());
  await mkdir(evidence, { recursive: true });
  const profile = await mkdtemp(path.join(tmpdir(), 'wsl-cli-cancel-'));
  const nonce = randomUUID();
  const missing = `cancel-wait-${nonce}`;
  const retained = 'src/components/cli-cancel-retained.txt';
  const forbidden = 'src/components/cli-cancel-after-return.txt';
  const secondMarker = `WSL_SECOND_CLI_${nonce}=`;
  const { app, page } = await launchApp({ live: true, userData: profile, appControlCancelGate: true });
  const electron = app.process();
  const results: Record<string, unknown> = { sandbox, profile, nonce, cleanupErrors: [] };
  const save = () => writeFile(path.join(evidence, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  const gate = async () =>
    GateSchema.parse(
      await app.evaluate(() => {
        const g = (globalThis as GateGlobal).__wslAppCancelGate;
        return { target: g.target, held: g.held, second: g.second, events: g.events, calls: g.calls };
      }),
    );
  const space = async () => (await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === 'taskflow-demo')!;
  const command = async (input: Omit<WorkbenchCommand, 'commandId' | 'workspaceId'> & Record<string, unknown>) => {
    const response = await page.evaluate((input) => window.studio.workbench.command(input as never), {
      ...input,
      workspaceId: 'taskflow-demo',
      commandId: randomUUID(),
    });
    expect(response.ok, JSON.stringify(response)).toBe(true);
  };
  const ownedPorts = new Set<number>();
  const baselinePorts = new Set<string>();
  const observe = async () => {
    const current = await space();
    if (current.managedApp?.state === 'running' && current.managedApp.guestPort) ownedPorts.add(current.managedApp.guestPort);
    return current;
  };
  const waitApp = async (state: string) => {
    await expect.poll(async () => (await observe()).managedApp?.state, { timeout: 180_000 }).toBe(state);
    return (await observe()).managedApp!;
  };
  let cwd: string | undefined;
  let sessionId: string | undefined;
  const runIds: string[] = [];
  let ownership: z.infer<typeof OwnershipSchema> | undefined;
  const cleanupErrors: string[] = [];
  let failure: unknown;
  const audit = async (runId: string) =>
    (await readFile(path.join(profile, 'app-control', runId, 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => AppAuditRecordSchema.parse(JSON.parse(line)));
  const markerFiles = async () => {
    if (!cwd) throw new Error('No owned project');
    return z
      .object({ retained: z.string().nullable(), forbidden: z.string().nullable() })
      .parse(
        JSON.parse(
          (
            await guest([
              'python3',
              '-I',
              '-c',
              `import pathlib,json,sys\np=pathlib.Path(sys.argv[1]);print(json.dumps({k:(p/f).read_text() if (p/f).exists() else None for k,f in [('retained',sys.argv[2]),('forbidden',sys.argv[3])]}))`,
              cwd,
              retained,
              forbidden,
            ])
          ).stdout,
        ),
      );
  };
  const sourceHashes = async () => {
    if (!cwd) throw new Error('No owned project');
    return SourceHashesSchema.parse(
      JSON.parse(
        (await guest(['python3', '-I', '-c', sourceHashFunction + '\nimport json,sys\nprint(json.dumps(source_hashes(sys.argv[1])))', cwd]))
          .stdout,
      ),
    );
  };
  const start = async (goal: string) => {
    if (!sessionId) throw new Error('No owned session');
    await command({
      type: 'confirmTask',
      sessionId,
      goal,
      targetRef: null,
      appId: null,
      captureId: null,
      allowedScopes: [retained, forbidden, 'agent/**'],
      acceptance: ['本轮真实 CLI 取消与隔离验证'],
    });
    const version = (await space()).sessions.find((s) => s.sessionId === sessionId)!.taskVersions.at(-1)!;
    await command({ type: 'startRun', sessionId, taskVersionId: version.taskVersionId });
    const runId = (await space()).runs.at(-1)!.runId;
    runIds.push(runId);
    results['runIds'] = runIds;
    await save();
    return runId;
  };
  const waitTerminal = async (runId: string, state: string, timeout: number) => {
    await expect
      .poll(
        async () => {
          const run = (await observe()).runs.find((r) => r.runId === runId)!;
          return run.state === state && !run.conversation?.cleanupPending;
        },
        { timeout, intervals: [500, 1000] },
      )
      .toBe(true);
    return (await space()).runs.find((r) => r.runId === runId)!;
  };
  try {
    const beforePorts = PortsSchema.parse(JSON.parse((await execute(sbx, ['ports', sandbox, '--json'], { timeout: 20_000 })).stdout));
    results['portsBefore'] = beforePorts;
    for (const port of beforePorts) baselinePorts.add(portKey(port));
    await app.evaluate((_electron, nonce) => {
      (globalThis as GateGlobal).__wslAppCancelGate.nonce = nonce;
    }, missing);
    await workshopNavigate(page, '空间');
    await page.getByRole('button', { name: '新建 App', exact: true }).click();
    await page.getByRole('button', { name: '创建标准应用', exact: true }).click();
    const createForm = page.getByRole('dialog', { name: '创建 App', exact: true });
    await createForm.getByLabel('App 名称').fill('Live 标准应用');
    await createForm.getByRole('button', { name: '保存 App' }).click();
    await expect(createForm).not.toBeVisible();
    await page.getByRole('button', { name: '管理 App', exact: true }).click();
    cwd = (await waitApp('created')).guestCwd;
    results['projectCwd'] = cwd;
    await page.getByRole('button', { name: '启动应用', exact: true }).click();
    await waitApp('running');
    await page.getByRole('dialog', { name: '空间 App' }).getByRole('button', { name: '关闭', exact: true }).click();
    sessionId = (await space()).sessions[0]!.sessionId;
    await command({ type: 'locateSession', sessionId });
    const session = page.getByRole('region', { name: 'Agent 会话内容' });
    const initialNavigation = await observe();
    results['navigationBeforeRun'] = { layout: initialNavigation.layout, activePaneId: initialNavigation.activePaneId };
    const initialHashes = await sourceHashes();
    results['sourceHashesInitial'] = initialHashes;
    await save();
    const firstScript = `import json,subprocess,pathlib,os
os.chdir(${JSON.stringify(cwd)})
s=subprocess.run(['wsl-app','ui.snapshot','{}'],capture_output=True,text=True,timeout=65)
assert s.returncode==0,s.stdout
r=json.loads(s.stdout);assert r['ok'];b=r['data']
a={'appInstanceId':b['appInstanceId'],'documentGeneration':b['documentGeneration'],'action':{'type':'waitFor','target':{'testid':'${missing}'},'state':'visible','timeoutMs':10000}}
p=subprocess.run(['wsl-app','ui.act',json.dumps(a)],capture_output=True,text=True,timeout=65)
pathlib.Path('${forbidden}').write_text('${nonce}')
subprocess.run(['wsl-app','status','{}'],check=True)
print('WSL_UNEXPECTED_AFTER_RETURN',p.returncode)`;
    const first = await start(
      `这是已授权的真实取消测试，不是欢迎语任务。仅操作新建项目 ${cwd}。先用普通命令工具 mkdir -p ${cwd}/src/components，然后在 ${cwd}/${retained} 写入精确内容 ${nonce}，不要末尾换行；运行 npm run agent:manifest。然后调用 MCP app_restart 一次，查询 app_status 前每次 shell sleep 15 秒，最多12次（总等待不超过3分钟），确认新实例 running。不要改其他源码，不读凭据、不联网、不安装依赖、不提升现有权限。app.*总预算64/并发4，MCP总调用少于20。接着立即用普通命令工具原样运行下面的 Python脚本，所有 wsl-app 必须在普通workspace-write命令沙箱运行，不能由MCP代替、不能重试。脚本将等待随机不存在元素，Host会从产品按钮取消整个任务；不要自行取消、不要绕过等待、不要提前创建 after-return 文件。10分钟内一次run。\npython3 - <<'PY'\n${firstScript}\nPY`,
    );
    await expect(session.getByRole('button', { name: '取消回复', exact: true })).toBeVisible();
    await expect
      .poll(
        async () => {
          const target = (await gate()).target;
          if (target) return target;
          const current = await observe();
          const run = current.runs.find((run) => run.runId === first)!;
          if (!['starting', 'running', 'cancelling'].includes(run.state)) {
            results['preflightTerminal'] = {
              runId: first,
              state: run.state,
              cleanupPending: run.conversation?.cleanupPending,
              appState: current.managedApp?.state,
              toolExecutions: run.conversation?.toolExecutions.length,
            };
            await save();
            throw new Error(`First model run ended in ${run.state} before issuing the required in-flight CLI call`);
          }
          return null;
        },
        { timeout: 600_000, intervals: [100, 250] },
      )
      .not.toBeNull();
    const entered = (await gate()).target!;
    expect(entered.runId).toBe(first);
    expect(entered.tool).toBe('app.ui.act');
    const targetArgs = AppToolInputSchemas['app.ui.act'].parse(entered.args);
    expect(targetArgs.action).toEqual({ type: 'waitFor', target: { testid: missing }, state: 'visible', timeoutMs: 10000 });
    ownership = OwnershipSchema.parse(
      JSON.parse((await guest(['python3', '-I', '-c', ownershipScript, missing, cwd, retained, forbidden])).stdout),
    );
    results['inflightOwnership'] = ownership;
    results['gateBeforeCancel'] = await gate();
    results['sourceBeforeCancel'] = ownership.markers;
    results['sourceHashesBeforeCancel'] = ownership.sourceHashes;
    const changedPaths = [...new Set([...Object.keys(initialHashes), ...Object.keys(ownership.sourceHashes)])].filter(
      (file) => initialHashes[file] !== ownership!.sourceHashes[file],
    );
    results['changedSourcePaths'] = changedPaths;
    expect(changedPaths).toContain(retained);
    expect(
      changedPaths.filter((file) => file !== retained && !file.startsWith('agent/')),
      'Model source changes must stay inside the frozen scope',
    ).toEqual([]);
    await save();
    expect(results['sourceBeforeCancel']).toEqual({ retained: nonce, forbidden: null });
    expect(
      ownership.tree.some((p) => /codex/i.test(p.comm)),
      'Owned helper subtree must include real Codex',
    ).toBe(true);
    expect((await gate()).held, 'Cancel must precede the real waitFor reply').toBeNull();
    expect(
      (await gate()).events.some((e) => e.type === 'abort'),
      'CLI must still be active before the product cancel',
    ).toBe(false);
    expect(Date.now() - entered.at, 'Evidence collection must finish while waitFor is genuinely in flight').toBeLessThan(8000);
    const beforeCancel = await observe();
    const navigationBeforeCancel = {
      layout: beforeCancel.layout,
      activePaneId: beforeCancel.activePaneId,
      sessionVisible: await session.isVisible(),
      cancelVisible: await session.getByRole('button', { name: '取消回复', exact: true }).isVisible(),
      at: Date.now(),
    };
    results['navigationBeforeCancel'] = navigationBeforeCancel;
    expect(navigationBeforeCancel.sessionVisible, 'AI restart must keep the real session visible').toBe(true);
    expect(navigationBeforeCancel.cancelVisible, 'The product cancel button must remain visible without navigating back').toBe(true);
    expect(beforeCancel.layout).toEqual(initialNavigation.layout);
    expect(beforeCancel.activePaneId).toBe(initialNavigation.activePaneId);
    results['cancelButtonClickedAt'] = Date.now();
    await session
      .getByRole('button', { name: '取消回复', exact: true })
      .click({ timeout: Math.max(1, 10_000 - (Date.now() - entered.at)) });
    results['cancelButtonClickFinishedAt'] = Date.now();
    expect(Date.now() - entered.at, 'The actual product click must finish inside the in-flight waitFor window').toBeLessThan(10_000);
    const cancelled = await waitTerminal(first, 'cancelled', 60_000);
    results['firstRun'] = { runId: cancelled.runId, state: cancelled.state, cleanupPending: cancelled.conversation?.cleanupPending };
    await save();
    await page.screenshot({ path: path.join(evidence, 'product-after-cancel.png') });
    const cancelledState = session.locator('[data-status="run:idle"]');
    await expect(cancelledState).toBeVisible();
    await expect(cancelledState).toContainText('已取消');
    await expect(session.getByRole('button', { name: '取消回复', exact: true })).toHaveCount(0);
    await expect.poll(async () => (await gate()).held, { timeout: 20_000 }).not.toBeNull();
    const held = (await gate()).held!;
    expect(held.id).toBe(entered.id);
    expect(held.result.ok).toBe(false);
    if (held.result.ok) throw new Error('Real cancellation reply expected');
    expect(held.result.error.code).toBe('cancelled');
    const firstAudit = await audit(first);
    results['firstAudit'] = firstAudit;
    expect(
      firstAudit.some((r) => r.tool === entered.tool && r.args.sha256 === hash(JSON.stringify(entered.args)) && r.outcome === 'cancelled'),
    ).toBe(true);
    await expect
      .poll(async () => JSON.parse((await guest(['python3', '-I', '-c', stoppedScript, JSON.stringify(ownership)])).stdout), {
        timeout: 30_000,
      })
      .toEqual({ remaining: [], channelExists: false });
    results['stoppedOwnership'] = JSON.parse((await guest(['python3', '-I', '-c', stoppedScript, JSON.stringify(ownership)])).stdout);
    expect(await markerFiles()).toEqual({ retained: nonce, forbidden: null });
    results['sourceAfterCancel'] = await markerFiles();
    const afterCancelHashes = await sourceHashes();
    results['sourceHashesAfterCancel'] = afterCancelHashes;
    expect(afterCancelHashes, 'Cancellation must retain every source file from the in-flight baseline').toEqual(ownership.sourceHashes);
    const running = (await observe()).managedApp!;
    expect(running.state, 'Task cancellation leaves the managed App running for the user').toBe('running');
    results['appAfterCancel'] = running;
    await save();
    await app.evaluate(() => {
      (globalThis as GateGlobal).__wslAppCancelGate.releaseOnSecond = true;
    });
    const secondScript = `import json,subprocess,os
os.chdir(${JSON.stringify(cwd)})
calls=[]
for tool in ['status','describe']:
 p=subprocess.run(['wsl-app',tool,'{}'],capture_output=True,text=True,timeout=65)
 r=json.loads(p.stdout);calls.append({'tool':'app.'+tool,'exitCode':p.returncode,'result':r})
 assert p.returncode==0 and r['ok'],r
print('${secondMarker}'+json.dumps({'version':1,'calls':calls},ensure_ascii=False))`;
    const second = await start(
      `这是同会话新的真实CLI隔离验证。不要修改任何文件，不要重启或停止应用。仅在 ${cwd} 用普通命令工具原样执行下面Python脚本，真实 wsl-app 必须在现有workspace-write命令沙箱运行，不调用MCP，不提权、不联网、不重试；脚本完成即简短结束，一次run最多10分钟。\npython3 - <<'PY'\n${secondScript}\nPY`,
    );
    const completed = await waitTerminal(second, 'completed', 600_000);
    const finalGate = await gate();
    results['gateAfterSecond'] = finalGate;
    expect(finalGate.second?.runId).toBe(second);
    expect(finalGate.second?.tool).toBe('app.status');
    expect(finalGate.second?.args).toEqual({});
    expect(finalGate.second?.id).not.toBe(entered.id);
    const cancelForwarded = finalGate.events.find((e) => e.type === 'cancel-forwarded');
    expect(cancelForwarded).toBeDefined();
    expect(
      finalGate.calls.filter((c) => c.runId === first && c.at >= cancelForwarded!.at),
      'Cancelled run cannot start any new control action',
    ).toEqual([]);
    expect(finalGate.events.filter((e) => e.type === 'released')).toEqual([
      { type: 'released', reason: 'second-real-request', at: expect.any(Number), callId: entered.id },
    ]);
    expect(finalGate.events.some((e) => e.type === 'cancel-forwarded')).toBe(true);
    expect(
      completed.conversation!.toolExecutions.filter((t) => t.command.startsWith('mcp:')),
      'Second run must use only the genuine CLI transport',
    ).toEqual([]);
    expect(finalGate.calls.filter((c) => c.runId === second).map((c) => c.tool)).toEqual(['app.status', 'app.describe']);
    const cliTools = completed.conversation!.toolExecutions.filter(
      (t) => !t.command.startsWith('mcp:') && t.command.includes(secondMarker),
    );
    results['secondCliCommands'] = cliTools.map((t) => ({
      id: t.id,
      turnId: t.turnId,
      exitCode: t.exitCode,
      truncated: t.truncated,
      outputSha256: hash(t.output),
    }));
    const receipts = cliTools.flatMap((t) =>
      t.output
        .split('\n')
        .filter((line) => line.startsWith(secondMarker))
        .map((line) => ({
          tool: t,
          receipt: z
            .object({
              version: z.literal(1),
              calls: z
                .array(
                  z
                    .object({ tool: z.enum(['app.status', 'app.describe']), exitCode: z.literal(0), result: AppControlResultSchema })
                    .strict(),
                )
                .length(2),
            })
            .strict()
            .parse(JSON.parse(line.slice(secondMarker.length))),
        })),
    );
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0]!;
    expect(receipt.tool.exitCode).toBe(0);
    expect(receipt.tool.truncated).toBe(false);
    expect(receipt.tool.output).not.toContain(missing);
    expect(receipt.tool.output).not.toContain('"code":"cancelled"');
    expect(receipt.receipt.calls.map((c) => c.tool)).toEqual(['app.status', 'app.describe']);
    const secondAudit = await audit(second);
    expect(
      secondAudit.map((record) => record.tool),
      'The new CLI owns exactly these two Main requests',
    ).toEqual(['app.status', 'app.describe']);
    results['secondAudit'] = secondAudit;
    results['secondCliReceipt'] = receipt.receipt;
    for (const call of receipt.receipt.calls) {
      expect(call.result.ok).toBe(true);
      expect(call.result.tool).toBe(call.tool);
      if (!call.result.ok) throw new Error('Successful independent CLI response expected');
      const data = z
        .object({ app: z.object({ appInstanceId: z.literal(running.appInstanceId), state: z.literal('running') }) })
        .parse(call.result.data);
      expect(data.app.appInstanceId).toBe(running.appInstanceId);
      expect(
        secondAudit.some((r) => r.runId === second && r.tool === call.tool && r.args.sha256 === hash('{}') && r.outcome === 'ok'),
      ).toBe(true);
    }
    expect((await space()).runs.find((r) => r.runId === first)!.state).toBe('cancelled');
    expect(await markerFiles()).toEqual({ retained: nonce, forbidden: null });
    expect(await audit(first), 'Late delivery must not add new actions to the cancelled run').toEqual(firstAudit);
    results['sourceAfterSecond'] = await markerFiles();
    const afterSecondHashes = await sourceHashes();
    results['sourceHashesAfterSecond'] = afterSecondHashes;
    expect(afterSecondHashes, 'The next run must preserve all retained source bytes').toEqual(ownership.sourceHashes);
    results['secondRun'] = { runId: completed.runId, state: completed.state, cleanupPending: completed.conversation?.cleanupPending };
    await page.screenshot({ path: path.join(evidence, 'product-second-completed.png') });
    results['outcome'] = 'passed';
  } catch (error) {
    failure = error;
    results['failure'] = String(error);
  } finally {
    try {
      results['rescueGateReleased'] = await app.evaluate(() => (globalThis as GateGlobal).__wslAppCancelGate.release('finally-rescue'));
      results['gateAtCleanup'] = await gate();
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    for (const runId of runIds) {
      try {
        const run = (await space()).runs.find((r) => r.runId === runId)!;
        if (['starting', 'running', 'cancelling'].includes(run.state)) {
          results['rescueCancelRun'] = runId;
          await command({ type: 'cancelRun', runId });
          await waitTerminal(runId, 'cancelled', 60_000);
        }
      } catch (error) {
        cleanupErrors.push(String(error));
      }
      try {
        await cp(path.join(profile, 'app-control', runId), path.join(evidence, 'app-control', runId), { recursive: true });
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    }
    try {
      if (ownership)
        results['ownershipAtCleanup'] = JSON.parse((await guest(['python3', '-I', '-c', stoppedScript, JSON.stringify(ownership)])).stdout);
      if (cwd) results['sourceAtCleanup'] = await markerFiles();
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    try {
      const managed = (await observe()).managedApp;
      if (managed) {
        if (managed.state !== 'stopped') await command({ type: 'stopApp' });
        await waitApp('stopped');
        expect((await space()).managedApp?.cleanupConfirmed).toBe(true);
        results['appAtCleanup'] = (await space()).managedApp;
      }
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    try {
      const ports = PortsSchema.parse(JSON.parse((await execute(sbx, ['ports', sandbox, '--json'], { timeout: 20_000 })).stdout));
      results['portsAfter'] = ports;
      results['remainingOwnedMappings'] = ports.filter((p) => ownedPorts.has(p.sandbox_port) && !baselinePorts.has(portKey(p)));
      expect(results['remainingOwnedMappings']).toEqual([]);
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    try {
      await app.close();
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    results['applicationExited'] = electron.exitCode !== null || electron.signalCode !== null;
    results['cleanupErrors'] = cleanupErrors;
    await save();
  }
  if (cleanupErrors.length)
    throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'CLI cancellation verification/cleanup failed');
  if (failure) throw failure;
  expect(results['applicationExited']).toBe(true);
  expect(results['rescueGateReleased']).toBe(false);
  expect(results['rescueCancelRun']).toBeUndefined();
});
