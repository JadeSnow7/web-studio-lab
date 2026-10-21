import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import helper from './guest-helper.py?raw';
import type { GuestFrame } from './sbx';

// Actual Linux helper/process tests. Python edits are lifecycle stimuli, never an
// Agent substitute and never connected to the frozen VS001 acceptance runner.
const roots: string[] = [];
// The managed execution host can virtualize /proc ancestry/session fields. The
// real guest cleanup tests require a faithful process table; unknown is not pass.
const faithfulProc =
  process.platform === 'linux' &&
  execFileSync(
    'python3',
    [
      '-c',
      "import os\nf=open('/proc/self/stat').read().rsplit(')',1)[1].split()\nprint(int(int(f[1])==os.getppid() and int(f[3])==os.getsid(0)))",
    ],
    { encoding: 'utf8' },
  ).trim() === '1';
if (process.platform === 'linux' && !faithfulProc)
  console.info(
    'NOT_RUN guest close/EOF descendant tests: host /proc PPID/session fields differ from process-reported identities; genuine sbx guest cleanup remains unverified.',
  );
function birth(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(')').at(-1)?.trim().split(/\s+/)[19];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
function killRecorded(item: { pid: number; birth: string }): void {
  if (birth(item.pid) !== item.birth) return;
  try {
    process.kill(item.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
const cleanupFailureStimulus = `
confirmed_cleanup = cleanup
def cleanup(sid, child, leader_identity=None):
    confirmed_cleanup(sid, child, leader_identity)
    raise RuntimeError("synthetic cleanup confirmation failure")
`;
const cleanupSignatureCheck = `
import inspect
if inspect.signature(cleanup) != inspect.signature(confirmed_cleanup):
    raise RuntimeError("cleanup test stub signature drift")
`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function startProbe(script: string, injectCleanupFailure = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'wsl-guest-workspace-test-'));
  roots.push(root);
  const marker = '\ntry:\n    start = read_start()';
  const prefix = helper.slice(0, helper.lastIndexOf(marker));
  // A synthetic confirmation failure after the real, descendant-free child has
  // stopped exercises preservation; this never changes production helper code.
  const stimulus = injectCleanupFailure ? `${cleanupFailureStimulus}${cleanupSignatureCheck}` : '';
  const child = spawn('python3', ['-u', '-c', `${prefix}\nCWD = sys.argv[1]\n${stimulus}\nmain(read_start())\n`, root], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const frames: GuestFrame[] = [];
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => frames.push(JSON.parse(line.slice('WSL_GUEST_FRAME:'.length)) as GuestFrame));
  const done = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const runId = randomUUID();
  child.stdin.write(
    JSON.stringify({
      type: 'start',
      mode: 'codex',
      argv: ['python3', '-u', '-c', script],
      workspace: { runId, files: [{ path: 'src/App.tsx', base64: Buffer.from('before').toString('base64') }] },
    }) + '\n',
  );
  return { root, child, frames, done, runId, stderr: () => stderr };
}

describe('guest cleanup stimulus (portable Python boundary)', () => {
  it.each([false, true])('matches production and forwards leader identity (explicit=%s)', (explicit) => {
    const prefix = helper.slice(0, helper.lastIndexOf('\ntry:\n    start = read_start()'));
    const script = `${prefix}
${cleanupFailureStimulus}
${cleanupSignatureCheck}
calls = []
child = object()
leader_identity = ${explicit ? "{'pid': 42, 'startTicks': '123'}" : 'None'}
confirmed_cleanup = lambda *args: calls.append(args)
try:
    cleanup(42, child${explicit ? ', leader_identity' : ''})
except RuntimeError as error:
    assert str(error) == 'synthetic cleanup confirmation failure'
else:
    raise AssertionError('cleanup failure was not injected')
assert calls == [(42, child, leader_identity)], calls
`;
    const result = spawnSync('python3', ['-I', '-c', script], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(['sid, child', 'sid, child, leader_identity'])('rejects signature drift before cleanup: %s', (signature) => {
    const prefix = helper.slice(0, helper.lastIndexOf('\ntry:\n    start = read_start()'));
    const stimulus = cleanupFailureStimulus.replace(/def cleanup\([^)]*\)/, `def cleanup(${signature})`);
    const result = spawnSync(
      'python3',
      ['-I', '-c', `${prefix}\n${stimulus}\n${cleanupSignatureCheck}\nprint('CLEANUP_STARTED')\ncleanup(42, None)\n`],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cleanup test stub signature drift');
    expect(result.stdout).not.toContain('CLEANUP_STARTED');
  });
});

describe('Codex exec configuration at the production launch boundary', () => {
  it.each([
    { name: 'research fresh', kind: 'research', resume: false, previousResearch: false },
    { name: 'research resume', kind: 'research', resume: true, previousResearch: false },
    { name: 'standard without research grant fresh', kind: 'standard', resume: false, previousResearch: false },
    { name: 'standard without research grant resume', kind: 'standard', resume: true, previousResearch: false },
    { name: 'edu workspace fresh', kind: 'edu', resume: false, previousResearch: false },
    { name: 'edu workspace resume', kind: 'edu', resume: true, previousResearch: false },
    { name: 'Mota scratch fresh', kind: 'mota', resume: false, previousResearch: false },
    { name: 'standard absent grant after research', kind: 'standard', resume: false, previousResearch: true },
    { name: 'standard false grant resume after research', kind: 'standard', resume: true, previousResearch: true },
  ])('keeps MCP and search overrides in the exec layer for $name', async ({ kind, resume, previousResearch }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'wsl-guest-argv-'));
    roots.push(root);
    const marker = '\ntry:\n    start = read_start()';
    expect(helper.lastIndexOf(marker)).toBeGreaterThan(0);
    const prefix = helper.slice(0, helper.lastIndexOf(marker));
    // The real main() constructs argv. Only its external launch/socket/workspace
    // boundaries are replaced; no Codex, guest, model or socket listener starts.
    const resourceSource = `import os
def sealed_bundle(bundle):
    return os.open(os.devnull, os.O_RDONLY)
class AppCliSlots:
    def __init__(self, directory):
        self.active = {}
    def close(self):
        pass
`;
    const script = `${prefix}
from types import SimpleNamespace
from unittest.mock import patch
CWD = sys.argv[1]
tempfile.tempdir = CWD
RESOURCE_MCP_BASE64 = ${JSON.stringify(Buffer.from(resourceSource).toString('base64'))}
calls, workspace_requests, snapshots, cleaned = [], [], [], []
def record_popen(argv, **kwargs):
    calls.append({'argv': argv, 'cwd': kwargs['cwd']})
    raise RuntimeError('argv captured before launch')
def fake_workspace(request):
    workspace_requests.append(request)
    return SimpleNamespace(name=CWD + '/candidate', cleanup=lambda: cleaned.append(True))
def record_snapshot(directory, run_id, **kwargs):
    snapshots.append({'directory': directory, 'runId': run_id})
with patch.object(subprocess, 'Popen', record_popen), patch.object(socket, 'socket') as sockets, patch.dict(
    globals(), create_workspace=fake_workspace, snapshot_workspace=record_snapshot
):
    for request in json.loads(sys.argv[2]):
        main(request)
    socket_calls = sockets.call_count
    socket_closes = sockets.return_value.close.call_count
    print('ARGV_PROBE:' + json.dumps({'calls': calls, 'workspaceRequests': workspace_requests,
        'snapshots': snapshots, 'cleaned': cleaned, 'socketCalls': socket_calls, 'socketCloses': socket_closes}))
`;
    const search = kind === 'research' ? 'live' : 'disabled';
    const hasWorkspace = kind === 'edu' || kind === 'mota';
    const original = [
      'codex',
      'exec',
      '--sandbox',
      kind === 'mota' ? 'read-only' : 'workspace-write',
      '-c',
      `web_search="${search}"`,
      ...(kind === 'edu' ? ['-c', 'sandbox_workspace_write.writable_roots=[]'] : []),
      ...(resume ? ['resume', '--json', '--skip-git-repo-check', 'thread-1', '-'] : ['--json', '--skip-git-repo-check', '-']),
    ];
    const workspace = { runId: randomUUID(), files: [{ path: 'README.md', base64: 'eA==' }] };
    const request = {
      mode: 'codex',
      argv: original,
      observation: true,
      resourceBundle: {},
      ...(kind === 'research' ? { webResearch: true } : {}),
      ...(kind === 'standard' && resume ? { webResearch: false } : {}),
      ...(hasWorkspace ? { workspace, strictWorkspace: true } : {}),
      ...(kind === 'mota' ? { motaControl: true } : {}),
    };
    const requests = [
      ...(previousResearch
        ? [{ ...request, webResearch: true, argv: original.map((arg) => (arg === 'web_search="disabled"' ? 'web_search="live"' : arg)) }]
        : []),
      request,
    ];
    const result = spawnSync('python3', ['-I', '-c', script, root, JSON.stringify(requests)], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trim().split('\n');
    const probeLine = lines.find((line) => line.startsWith('ARGV_PROBE:'));
    if (!probeLine) throw new Error(`argv probe did not reach its launch boundary: ${result.stdout}`);
    const probe = z
      .object({
        calls: z.array(z.object({ argv: z.array(z.string()), cwd: z.string() })).length(requests.length),
        workspaceRequests: z.array(z.unknown()),
        snapshots: z.array(z.object({ directory: z.string(), runId: z.string() })),
        cleaned: z.array(z.literal(true)),
        socketCalls: z.literal(requests.length),
        socketCloses: z.literal(requests.length),
      })
      .parse(JSON.parse(probeLine.slice('ARGV_PROBE:'.length)));
    const standaloneOverride = 'model_providers.sandboxd.supports_standalone_web_search=true';
    if (previousResearch) {
      expect(probe.calls[0]?.argv.filter((arg) => arg === standaloneOverride)).toEqual([standaloneOverride]);
    }
    const launched = probe.calls.at(-1);
    if (!launched) throw new Error('missing recorded launch');
    const execIndex = launched.argv.indexOf('exec');
    expect(launched.argv.slice(0, execIndex)).toEqual(hasWorkspace ? ['codex', '--cd', path.join(root, 'candidate')] : ['codex']);
    expect(launched.cwd).toBe(hasWorkspace ? path.join(root, 'candidate') : root);
    const overrides = launched.argv.flatMap((arg, index) => {
      if (arg !== '-c') return [];
      expect(index).toBeGreaterThan(execIndex);
      expect(index).toBeLessThan(launched.argv.indexOf(resume ? 'resume' : '--json'));
      return [launched.argv[index + 1]];
    });
    expect(overrides).toEqual([
      'mcp_servers.wsl_space.command="python3"',
      expect.stringMatching(/^mcp_servers\.wsl_space\.args=/),
      'mcp_servers.wsl_space.required=true',
      ...(kind === 'research' ? ['mcp_servers.wsl_space.tools.research_open.approval_mode="approve"', standaloneOverride] : []),
      `web_search="${search}"`,
      ...(kind === 'edu' ? ['sandbox_workspace_write.writable_roots=[]'] : []),
    ]);
    // Only granted research adds its narrow tool approval and provider declaration.
    // No global approval, default policy or tool hints may enter the complete list.
    // MCP key/value pairs precede the unchanged caller-supplied exec args,
    // including sandbox, search policy, resume identity and final stdin marker.
    expect(launched.argv.slice(execIndex + (kind === 'research' ? 11 : 7))).toEqual(original.slice(2));
    const serializedArgs = launched.argv.find((arg) => arg.startsWith('mcp_servers.wsl_space.args='));
    if (!serializedArgs) throw new Error('missing MCP arguments');
    const mcpArgs = z
      .array(z.string())
      .length(7)
      .parse(JSON.parse(serializedArgs.slice('mcp_servers.wsl_space.args='.length)));
    expect(mcpArgs.slice(0, 4)).toEqual(['-I', '-u', '-c', resourceSource]);
    expect(mcpArgs[4]).toMatch(/^\/proc\/\d+\/fd\/\d+$/);
    expect(mcpArgs[5]).toEqual(expect.stringContaining(`${root}/wsl-observe-`));
    expect(mcpArgs[5]).toMatch(/\/read\.sock$/);
    expect(mcpArgs[6]).toBe(kind === 'research' ? 'research' : kind === 'mota' ? 'mota' : 'text');
    expect(probe.workspaceRequests).toEqual(hasWorkspace ? [workspace] : []);
    expect(probe.snapshots).toEqual(hasWorkspace ? [{ directory: path.join(root, 'candidate'), runId: workspace.runId }] : []);
    expect(probe.cleaned).toEqual(hasWorkspace ? [true] : []);
    expect(
      lines.filter((line) => line.startsWith('WSL_GUEST_FRAME:')).map((line) => JSON.parse(line.slice('WSL_GUEST_FRAME:'.length))),
    ).toEqual(
      requests.flatMap(() => [
        { type: 'error', error: 'argv captured before launch' },
        { type: 'cleanup', ok: true },
      ]),
    );
    expect(await readdir(root)).toEqual([]);
  });
});

describe.skipIf(process.platform !== 'linux')('actual guest run-copy and cleanup boundaries', () => {
  it('returns the complete inventory after nonzero exit, then removes its exclusive directory', async () => {
    const probe = await startProbe(
      "from pathlib import Path\nPath('src/App.tsx').write_text('changed')\nPath('extra.txt').write_text('outside allowed delta')\nprint('final stdout',flush=True)\nimport sys\nprint('final stderr',file=sys.stderr,flush=True)\nsys.exit(7)",
    );
    try {
      expect(await probe.done, probe.stderr()).toBe(0);
      expect(probe.frames.find((frame) => frame.type === 'exit')).toEqual({ type: 'exit', exitCode: 7 });
      const snapshot = probe.frames.find((frame) => frame.type === 'workspace');
      expect(snapshot).toMatchObject({ runId: probe.runId, files: [{ path: 'extra.txt' }, { path: 'src/App.tsx' }] });
      expect(
        probe.frames
          .filter((frame) => frame.type === 'output')
          .map((frame) => frame.type === 'output' && frame.data)
          .join(''),
      ).toContain('final stderr');
      expect(probe.frames.at(-1)).toEqual({ type: 'cleanup', ok: true });
      expect(await readdir(probe.root)).toEqual([]);
    } finally {
      probe.child.stdin.end();
      if (probe.child.exitCode === null) probe.child.kill('SIGKILL');
      await probe.done;
    }
  });

  it('rejects symlinks without transferring their targets and retains candidate after process cleanup', async () => {
    const probe = await startProbe("import os\nos.symlink('/etc/passwd','src/App-link.tsx')");
    try {
      expect(await probe.done, probe.stderr()).toBe(0);
      expect(probe.frames.some((frame) => frame.type === 'error' && frame.error.includes('symlink'))).toBe(true);
      expect(probe.frames.some((frame) => frame.type === 'workspace')).toBe(false);
      expect(probe.frames.at(-1)).toEqual({ type: 'cleanup', ok: true });
      expect((await readdir(probe.root)).length).toBe(1);
      expect(probe.frames.some((frame) => frame.type === 'error' && frame.error.includes('candidate retained'))).toBe(true);
    } finally {
      probe.child.stdin.end();
      if (probe.child.exitCode === null) probe.child.kill('SIGKILL');
      await probe.done;
    }
  });

  it('retains the exclusive cwd and edits on a synthetic cleanup-confirmation failure (no descendants or model)', async () => {
    const probe = await startProbe("from pathlib import Path\nPath('src/App.tsx').write_text('retained on unknown cleanup')", true);
    try {
      expect(await probe.done, probe.stderr()).toBe(0);
      expect(probe.frames.at(-1)).toEqual({ type: 'cleanup', ok: false, error: 'synthetic cleanup confirmation failure' });
      expect(probe.frames.some((frame) => frame.type === 'workspace')).toBe(false);
      const retained = z
        .object({ type: z.literal('error'), runId: z.uuid(), workspaceDir: z.string(), cleanupConfirmed: z.literal(false) })
        .parse(probe.frames.find((frame) => frame.type === 'error' && frame.error.includes('workspace retained')));
      expect(retained.runId).toBe(probe.runId);
      expect(path.dirname(retained.workspaceDir)).toBe(probe.root);
      expect(path.basename(retained.workspaceDir)).toContain(`wsl-vs001-${probe.runId}-`);
      expect(await readdir(probe.root)).toEqual([path.basename(retained.workspaceDir)]);
      expect(await readFile(path.join(retained.workspaceDir, 'src/App.tsx'), 'utf8')).toBe('retained on unknown cleanup');
      const leader = probe.frames.find((frame) => frame.type === 'ready');
      if (leader?.type === 'ready') expect(() => process.kill(leader.pid, 0)).toThrow();
    } finally {
      probe.child.stdin.end();
      if (probe.child.exitCode === null) probe.child.kill('SIGKILL');
      await probe.done;
    }
  });

  it.skipIf(!faithfulProc).each(['close', 'eof'])(
    `${faithfulProc ? '' : '[not_run: host /proc ancestry/session mismatch] '}%s drains final output, preserves the edit and reaps a detached grandchild before acknowledgment`,
    async (mode) => {
      const probe = await startProbe(
        "import subprocess,signal,time,sys\nfrom pathlib import Path\nPath('src/App.tsx').write_text('cancelled edit')\np=subprocess.Popen(['sleep','60'],start_new_session=True)\nprint('BG_PID:'+str(p.pid),flush=True)\ndef stop(sig,frame):\n print('TAIL_STDOUT',flush=True)\n print('TAIL_STDERR',file=sys.stderr,flush=True)\n sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\nprint('BODY_READY',flush=True)\ntime.sleep(60)",
      );
      const owned: { pid: number; birth: string }[] = [];
      try {
        await expect
          .poll(
            () =>
              probe.frames
                .filter((frame) => frame.type === 'output')
                .map((frame) => frame.type === 'output' && frame.data)
                .join(''),
            { timeout: 5000 },
          )
          .toContain('BODY_READY');
        const output = probe.frames
          .filter((frame) => frame.type === 'output')
          .map((frame) => frame.type === 'output' && frame.data)
          .join('');
        const detached = Number(output.match(/BG_PID:(\d+)/)![1]);
        const leader = probe.frames.find((frame) => frame.type === 'ready');
        for (const pid of [detached, ...(leader?.type === 'ready' ? [leader.pid] : [])]) {
          const identity = birth(pid);
          if (identity) owned.push({ pid, birth: identity });
        }
        if (mode === 'close') probe.child.stdin.write('{"type":"close"}\n');
        else probe.child.stdin.end();
        expect(await probe.done, probe.stderr()).toBe(0);
        const tail = probe.frames
          .filter((frame) => frame.type === 'output')
          .map((frame) => frame.type === 'output' && frame.data)
          .join('');
        expect(tail).toContain('TAIL_STDOUT');
        expect(tail).toContain('TAIL_STDERR');
        expect(() => process.kill(detached, 0)).toThrow();
        const snapshot = probe.frames.find((frame) => frame.type === 'workspace');
        expect(snapshot?.type === 'workspace' && snapshot.files[0]?.base64).toBe(Buffer.from('cancelled edit').toString('base64'));
        expect(probe.frames.at(-1)).toEqual({ type: 'cleanup', ok: true });
        expect(await readdir(probe.root)).toEqual([]);
      } finally {
        for (const item of owned) killRecorded(item);
        probe.child.stdin.end();
        await Promise.race([probe.done, new Promise<void>((complete) => setTimeout(complete, 1000))]);
        if (probe.child.exitCode === null) probe.child.kill('SIGKILL');
        await probe.done;
      }
    },
    10000,
  );
});

describe('guest candidate snapshot link rejection (portable Python boundary)', () => {
  it.each(['symlink', 'hardlink'])('refuses %s without reading its target', async (kind) => {
    const root = await mkdtemp(path.join(tmpdir(), 'wsl-snapshot-link-'));
    roots.push(root);
    const marker = '\ntry:\n    start = read_start()';
    const prefix = helper.slice(0, helper.lastIndexOf(marker));
    const script = `${prefix}\nroot=sys.argv[1]\nwith open(root+'/source.ts','w') as f: f.write('keep')\nos.${kind === 'symlink' ? 'symlink' : 'link'}(root+'/source.ts',root+'/linked.ts')\nsnapshot_workspace(root,sys.argv[2])\n`;
    expect(() =>
      execFileSync('python3', ['-c', script, root, randomUUID()], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    ).toThrow(kind);
    expect(await readFile(path.join(root, 'source.ts'), 'utf8')).toBe('keep');
  });
});

describe('edu strict candidate snapshots (portable Python boundary)', () => {
  it.each(
    ['node_modules', 'dist', '.vite'].flatMap((directory) =>
      ['empty', 'file', 'symlink', 'hardlink'].map((kind) => ({
        directory,
        kind,
      })),
    ),
  )('rejects and retains $directory/$kind after child exit', async ({ directory, kind }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'wsl-edu-strict-'));
    roots.push(root);
    const prefix = helper.slice(0, helper.lastIndexOf('\ntry:\n    start = read_start()'));
    const stimulus =
      `from pathlib import Path\nimport os\nPath('admin/src/App.tsx').write_text('changed')\nPath('${directory}').mkdir()\n` +
      (kind === 'empty'
        ? ''
        : kind === 'file'
          ? `Path('${directory}/outside.txt').write_text('outside')`
          : `Path('${directory}/outside.txt').write_text('outside')\nos.${kind === 'symlink' ? 'symlink' : 'link'}('${directory}/outside.txt','${directory}/linked.ts')`);
    const runId = randomUUID();
    // Only process-table cleanup is substituted: the actual helper owns the cwd,
    // launches a descendant-free local child and executes both snapshot paths.
    const script = `${prefix}\nCWD=sys.argv[1]\ndef cleanup(sid, child, leader_identity=None):\n    child.wait()\nmain(json.loads(sys.argv[2]))\n`;
    const frames = execFileSync(
      'python3',
      [
        '-c',
        script,
        root,
        JSON.stringify({
          mode: 'codex',
          argv: ['python3', '-c', stimulus],
          strictWorkspace: true,
          workspace: {
            runId,
            files: [{ path: 'admin/src/App.tsx', base64: 'YmVmb3Jl' }],
          },
        }),
      ],
      { encoding: 'utf8', input: '' },
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line.slice('WSL_GUEST_FRAME:'.length)));
    expect(frames.filter((frame) => frame.type === 'workspace')).toEqual([]);
    const retained = frames.find((frame) => frame.type === 'error' && frame.error.includes('candidate retained'));
    expect(retained).toMatchObject({ runId });
    expect(retained.error).toContain(`guest edu workspace forbidden directory: ${directory}`);
    expect(path.dirname(retained.workspaceDir)).toBe(root);
    expect(await readFile(path.join(retained.workspaceDir, 'admin/src/App.tsx'), 'utf8')).toBe('changed');
    expect(await readdir(root)).toEqual([path.basename(retained.workspaceDir)]);
    expect(frames.at(-1)).toEqual({ type: 'cleanup', ok: true });
  });

  it.each(['foo', 'server/new-empty', '.git', '.data'])('rejects and retains new empty directory %s', async (directory) => {
    const root = await mkdtemp(path.join(tmpdir(), 'wsl-edu-empty-'));
    roots.push(root);
    const prefix = helper.slice(0, helper.lastIndexOf('\ntry:\n    start = read_start()'));
    const script = `${prefix}\nCWD=sys.argv[1]\ndef cleanup(sid,child,leader_identity=None):\n    child.wait()\nmain(json.loads(sys.argv[2]))\n`;
    const runId = randomUUID();
    const frames = execFileSync(
      'python3',
      [
        '-c',
        script,
        root,
        JSON.stringify({
          mode: 'codex',
          strictWorkspace: true,
          argv: [
            'python3',
            '-c',
            `from pathlib import Path\nPath('${directory}').mkdir(parents=True)\nPath('admin/src/App.tsx').write_text('changed')`,
          ],
          workspace: {
            runId,
            files: [
              { path: 'admin/src/App.tsx', base64: 'YmVmb3Jl' },
              { path: 'server/app.py', base64: 'YmFzZQ==' },
            ],
          },
        }),
      ],
      { encoding: 'utf8', input: '' },
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line.slice('WSL_GUEST_FRAME:'.length)));
    expect(frames.filter((frame) => frame.type === 'workspace')).toEqual([]);
    const retained = frames.find((frame) => frame.type === 'error' && frame.error.includes('candidate retained'));
    expect(retained.error).toContain(`guest edu workspace forbidden directory: ${directory}`);
    expect(await readdir(path.join(retained.workspaceDir, directory))).toEqual([]);
    expect(await readFile(path.join(retained.workspaceDir, 'admin/src/App.tsx'), 'utf8')).toBe('changed');
    expect(frames.at(-1)).toEqual({ type: 'cleanup', ok: true });
  });

  it.each([false, true])('accepts legal candidate with strict=%s', async (strict) => {
    const root = await mkdtemp(path.join(tmpdir(), 'wsl-legal-snapshot-'));
    roots.push(root);
    const prefix = helper.slice(0, helper.lastIndexOf('\ntry:\n    start = read_start()'));
    const script = `${prefix}\nos.makedirs(sys.argv[1]+'/admin/src/new-empty')\nPath(sys.argv[1]+'/admin/src/App.tsx').write_text('legal')\nsnapshot_workspace(sys.argv[1],sys.argv[2],strict=${strict ? 'True' : 'False'},original_files=[{"path":"admin/src/App.tsx"}])\n`;
    const frames = execFileSync('python3', ['-c', script, root, randomUUID()], { encoding: 'utf8' });
    expect(JSON.parse(frames.slice('WSL_GUEST_FRAME:'.length))).toMatchObject({
      type: 'workspace',
      files: [{ path: 'admin/src/App.tsx', base64: 'bGVnYWw=' }],
    });
  });

  it('standard snapshots preserve their existing build-directory filtering', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wsl-standard-snapshot-'));
    roots.push(root);
    const prefix = helper.slice(0, helper.lastIndexOf('\ntry:\n    start = read_start()'));
    const script = `${prefix}\nfor directory in ('node_modules','dist','.vite'):\n    os.mkdir(sys.argv[1]+'/'+directory)\n    os.symlink('/not-readable',sys.argv[1]+'/'+directory+'/link')\nsnapshot_workspace(sys.argv[1],sys.argv[2])\n`;
    const frames = execFileSync('python3', ['-c', script, root, randomUUID()], {
      encoding: 'utf8',
    });
    expect(JSON.parse(frames.slice('WSL_GUEST_FRAME:'.length))).toMatchObject({
      type: 'workspace',
      files: [],
    });
  });

  it.each(['false', '0', 'null', '{}'])('rejects nonboolean strictWorkspace %s at the start boundary', (value) => {
    const prefix = helper.slice(0, helper.lastIndexOf('\ntry:\n    start = read_start()'));
    const script = `${prefix}\nfrom types import SimpleNamespace\nsys.platform='linux'\nctypes.CDLL=lambda *args,**kwargs:SimpleNamespace(prctl=lambda *args:0)\nread_start()\n`;
    const result = spawnSync('python3', ['-c', script], {
      encoding: 'utf8',
      input:
        JSON.stringify({
          type: 'start',
          mode: 'codex',
          argv: ['codex'],
          strictWorkspace: JSON.parse(value === 'false' ? '"false"' : value),
        }) + '\n',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ValueError: invalid observation capability');
  });
  it.each(['valid', 'writable', 'resume', 'cli', 'missing-scratch', 'images', 'search'])(
    'checks the trusted Mota read-only capability: %s',
    (mode) => {
      const prefix = helper.slice(0, helper.lastIndexOf('\ntry:\n    start = read_start()'));
      const script = `${prefix}\nfrom types import SimpleNamespace\nsys.platform='linux'\nctypes.CDLL=lambda *args,**kwargs:SimpleNamespace(prctl=lambda *args:0)\nread_start()\n`;
      const start: Record<string, unknown> = {
        type: 'start',
        mode: 'codex',
        argv: [
          'codex',
          'exec',
          '--sandbox',
          mode === 'writable' ? 'workspace-write' : 'read-only',
          '-c',
          'web_search="disabled"',
          '--json',
          '--skip-git-repo-check',
          '-',
        ],
        motaControl: true,
        observation: true,
        observationImages: mode === 'images',
        strictWorkspace: true,
        workspace: { runId: randomUUID(), files: [{ path: 'README.md', base64: 'eA==' }] },
        resourceBundle: {},
      };
      if (mode === 'resume') (start.argv as string[]).push('resume');
      if (mode === 'cli') start.duplex = true;
      if (mode === 'missing-scratch') delete start.workspace;
      if (mode === 'search') start.webResearch = true;
      const result = spawnSync('python3', ['-c', script], {
        encoding: 'utf8',
        input: JSON.stringify(start) + '\n',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      expect(result.status).toBe(mode === 'valid' ? 0 : 1);
      if (mode !== 'valid') expect(result.stderr).toContain('invalid Mota read-only capability');
    },
  );
  it.each(['valid', 'resume', 'missing-socket', 'edu', 'mota', 'disabled', 'extra-config', 'truthy'])(
    'checks finite public research capability: %s',
    (mode) => {
      const prefix = helper.slice(0, helper.lastIndexOf('\ntry:\n    start = read_start()'));
      const script = `${prefix}\nfrom types import SimpleNamespace\nsys.platform='linux'\nctypes.CDLL=lambda *args,**kwargs:SimpleNamespace(prctl=lambda *args:0)\nread_start()\n`;
      const argv = [
        'codex',
        'exec',
        '--sandbox',
        'workspace-write',
        '-c',
        mode === 'disabled' ? 'web_search="disabled"' : 'web_search="live"',
        ...(mode === 'resume' ? ['resume', '--json', '--skip-git-repo-check', 'thread-1', '-'] : ['--json', '--skip-git-repo-check', '-']),
      ];
      if (mode === 'extra-config') argv.push('-c', 'web_search="live"');
      const start = {
        type: 'start',
        mode: 'codex',
        argv,
        webResearch: mode === 'truthy' ? 'true' : true,
        observation: mode !== 'missing-socket',
        resourceBundle: {},
        ...(mode === 'edu' ? { eduOwner: {} } : {}),
        ...(mode === 'mota' ? { motaControl: true } : {}),
      };
      const result = spawnSync('python3', ['-c', script], { encoding: 'utf8', input: JSON.stringify(start) + '\n' });
      expect(result.status, result.stderr).toBe(['valid', 'resume'].includes(mode) ? 0 : 1);
    },
  );
  it('research kernel-peer admission rejects siblings, stale leaders, replaced callers and unknown ancestry', () => {
    const prefix = helper.slice(0, helper.lastIndexOf('\ntry:\n    start = read_start()'));
    const script = `${prefix}
from unittest.mock import patch
sys.platform = 'linux'
socket.SO_PEERCRED = 17
class Peer:
    def __init__(self, pid=12, uid=None):
        self.pid, self.uid = pid, os.getuid() if uid is None else uid
    def getsockopt(self, *args):
        return struct.pack('3i', self.pid, self.uid, 0)
leader = {'pid': 10, 'startTicks': '100'}
base = {10: {'pid': 10, 'parent': 1, 'startTicks': '100'},
        11: {'pid': 11, 'parent': 10, 'startTicks': '110'},
        12: {'pid': 12, 'parent': 11, 'startTicks': '120'},
        20: {'pid': 20, 'parent': 1, 'startTicks': '90'}}
with patch.dict(globals(), research_process=lambda pid: dict(base[pid])):
    admitted = research_peer_owned(Peer(), leader)
    assert admitted == {'pid': 12, 'startTicks': '120'}
    assert research_peer_owned(Peer(20), leader) is None
    assert research_peer_owned(Peer(uid=os.getuid()+1), leader) is None
    assert research_peer_owned(Peer(), {'pid': 10, 'startTicks': '99'}) is None
    assert research_peer_owned(Peer(), leader, {'pid': 12, 'startTicks': '119'}) is None
    del base[10]
    assert research_peer_owned(Peer(), leader, admitted) is None
    base[10] = {'pid': 10, 'parent': 1, 'startTicks': '100'}
    base[12]['parent'] = 20
    assert research_peer_owned(Peer(), leader, admitted) is None
    base[12]['parent'] = 11
    base[12]['startTicks'] = '121'
    assert research_peer_owned(Peer(), leader, admitted) is None
with patch.dict(globals(), research_process=lambda pid: (_ for _ in ()).throw(PermissionError())):
    assert research_peer_owned(Peer(), leader) is None
sys.platform = 'darwin'
assert research_peer_owned(Peer(), leader) is None
print('peer boundary passed')
`;
    const result = spawnSync('python3', ['-I', '-c', script], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('peer boundary passed');
  });
});
