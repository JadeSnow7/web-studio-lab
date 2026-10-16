import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { AppService } from './app-service';
import { GuestProcess } from './sbx';

it.each(['cwd', 'pythonpath', 'user-site'])('isolates controller and source helper imports from synthetic %s modules', async (kind) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'wsl-source-python-')));
  const target = { workspaceId: 'source-isolation', projectId: 'aa765d34-8748-4fef-adf4-6d2e2e7a3b5a' };
  const projects = path.join(root, 'projects');
  const project = path.join(projects, target.projectId);
  const userBase = path.join(root, 'user-base');
  const pythonPath = path.join(root, 'python-path');
  const marker = path.join(root, 'untrusted-import');
  const pythonVersion = (
    await promisify(execFile)('python3', ['-I', '-B', '-c', 'import sys; print("python%d.%d"%sys.version_info[:2])'])
  ).stdout.trim();
  const userSites = [path.join(userBase, 'lib', pythonVersion, 'site-packages'), path.join(userBase, 'lib/python/site-packages')];
  const registryPath = path.join(root, 'registry.json');
  let service: AppService | undefined;
  try {
    for (const directory of [project, pythonPath, ...userSites, path.join(root, 'home')]) await mkdir(directory, { recursive: true });
    await writeFile(path.join(project, '.wsl-identity.json'), JSON.stringify({ ...target, environmentId: 'sandbox' }));
    await writeFile(path.join(project, 'source.ts'), 'export const value = "synthetic";\n');
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, sandbox: 'synthetic', apps: [{ ...target, state: 'stopped', cleanupConfirmed: true }] }),
    );
    const hostile = `with open(${JSON.stringify(marker)}, 'a') as handle:\n    handle.write('synthetic import executed')\nraise RuntimeError('synthetic import executed')\n`;
    for (const directory of kind === 'cwd' ? [project] : kind === 'pythonpath' ? [pythonPath] : userSites) {
      for (const name of ['json.py', 'sitecustomize.py', 'usercustomize.py']) await writeFile(path.join(directory, name), hostile);
    }
    const wrapper = path.join(root, 'sbx-import-fixture');
    // Keep real imports/argv; replace only the Linux lifecycle with a fixture-local collector call.
    // Its synthetic cleanup frame tests transport wiring, not actual guest process cleanup.
    const controllerTail = `\nstart = json.loads(sys.stdin.readline())\nemit('ready', pid=os.getpid())\nargs = start['argv']\nindex = args.index('-c') + 1\nargs[index] = args[index].replace("ROOT = Path('/home/agent/workspace/.wsl-apps')", ${JSON.stringify(`ROOT = Path(${JSON.stringify(projects)})`)})\nresult = subprocess.run(args, input=start.get('prompt', '')+'\\n', capture_output=True, text=True, check=False)\nemit('output', stream='stdout', data=result.stdout)\nemit('output', stream='stderr', data=result.stderr)\nemit('exit', exitCode=result.returncode)\nemit('cleanup', ok=True)\n`;
    await writeFile(
      wrapper,
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(process.argv.indexOf('python3') + 1);
const index = args.indexOf('-c') + 1;
const end = args[index].lastIndexOf('\\ntry:\\n    start = read_start()');
if (end < 0) throw new Error('controller fixture boundary missing');
args[index] = args[index].slice(0, end) + ${JSON.stringify(controllerTail)};
const result = spawnSync('python3', args, { stdio: 'inherit', cwd: ${JSON.stringify(project)}, env: { ...process.env, HOME: ${JSON.stringify(path.join(root, 'home'))}, PYTHONPATH: ${JSON.stringify(pythonPath)}, PYTHONUSERBASE: ${JSON.stringify(userBase)} } });
process.exit(result.status ?? 1);
`,
      { mode: 0o700 },
    );
    service = new AppService(
      {
        getStatus: () => ({ available: true, sandbox: 'synthetic', cwd: project, version: 'synthetic', reason: null }),
        runtimeTarget: () => ({ binary: wrapper, sandbox: 'synthetic' }),
        start: (request, onFrame) => new GuestProcess(wrapper, 'synthetic', request, onFrame),
      },
      { registryPath },
    );
    const result = await service.sourceSnapshot(target).catch((error: unknown) => error);
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result).toMatchObject({
      ok: true,
      cleanupConfirmed: true,
      snapshot: { ...target, files: expect.arrayContaining([expect.objectContaining({ path: 'source.ts' })]) },
    });
  } finally {
    await service?.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
