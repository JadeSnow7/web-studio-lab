import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { APP_SOURCE_TRANSPORT, AppImportRequestSchema, EDU_REQUIRED_FILES } from '@wsl/protocol';
import { collectEduSource } from './edu-source';
import { describeImport } from './import-source';
import { AppService } from '../../../../service/src/app-service';
import { encodeGuestStart, type GuestStart } from '../../../../service/src/sbx';
import guestHelper from '../../../../service/src/guest-helper.py?raw';

it('transports a real previewable full-budget source with long UTF-8 paths through the production injected envelope', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-frame-'));
  let service: AppService | undefined;
  try {
    const contents: Record<string, string> = {
      'admin/package.json': JSON.stringify({ scripts: { build: 'node -e ""', typecheck: 'node -e ""' } }),
      'admin/package-lock.json': '{"lockfileVersion":3,"packages":{}}',
      'server/app.py': '# transport fixture\n',
      'server/wsl_runtime.py': '# transport fixture\n',
      'server/requirements.lock': '# no dependencies\n',
      'server/requirements-test.lock': '# no dependencies\n',
    };
    const remaining = 524288 - Object.values(contents).reduce((sum, value) => sum + Buffer.byteLength(value), 0);
    for (let index = 0; index < 250; index++) {
      const name = 'admin/src/' + '中'.repeat(80) + '/' + 'a'.repeat(100) + '/' + String(index).padStart(3, '0') + 'x'.repeat(161) + '.ts';
      const size = Math.floor(remaining / 250) + (index < remaining % 250 ? 1 : 0);
      contents[name] = '//' + 'x'.repeat(size - 3) + '\n';
    }
    const directories = new Set(Object.keys(contents).map((name) => path.dirname(path.join(root, name))));
    for (const directory of directories) await mkdir(directory, { recursive: true });
    for (const [name, content] of Object.entries(contents)) await writeFile(path.join(root, name), content);
    const git = (...args: string[]) =>
      execFileSync(
        '/usr/bin/git',
        [
          '-C',
          root,
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'user.name=Transport fixture',
          '-c',
          'user.email=fixture@example.invalid',
          ...args,
        ],
        { stdio: 'pipe' },
      );
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'local source fixture');
    const collected = await collectEduSource(root, new AbortController().signal);
    expect(describeImport(collected, 'Frame fixture')).toMatchObject({ profile: 'edu-web', fileCount: 256, totalBytes: 524288 });
    expect(EDU_REQUIRED_FILES.every((file) => collected.files.some((item) => item.path === file))).toBe(true);
    expect(Math.max(...collected.files.map((file) => file.path.length))).toBe(359);
    const input = AppImportRequestSchema.parse({
      workspaceId: 'frame-test',
      projectId: '128ff490-fde9-40d1-a7ee-0f4b55c2d8a5',
      importOperationId: 'b9505f08-bd69-4f99-917c-ea8debc6d048',
      ...collected,
    });
    const starts: GuestStart[] = [];
    service = new AppService({
      getStatus: () => ({ available: true, sandbox: 'fixture', reason: null, version: 'fixture', cwd: '/home/agent/workspace' }),
      runtimeTarget: () => {
        throw new Error('No guest permitted');
      },
      start: (start, emit) => {
        starts.push(start);
        emit({
          type: 'output',
          stream: 'stdout',
          data:
            'WSL_APP_RESULT:' +
            JSON.stringify({
              outcome: 'imported',
              retryable: false,
              errorCode: null,
              importOperationId: input.importOperationId,
              profile: { projectKind: 'edu-web', profileVersion: 1, source: input.source },
              sourceSha256: input.source.sourceSha256,
            }) +
            '\n',
        });
        const done = { confirmed: true, exitCode: 0, error: null };
        return { done: Promise.resolve(done), close: async () => done };
      },
    });
    expect((await service.importSource(input)).outcome).toBe('imported');
    const start = starts[0];
    if (!start || start.mode !== 'codex' || !start.prompt) throw new Error('wrong production envelope');
    expect(start.argv.at(-1)).toContain('OWNED_PROCESS_BASE64 = "');
    expect(start.argv.at(-1)).not.toContain('OWNED_PROCESS_BASE64 = ""');
    expect(Buffer.byteLength(JSON.stringify(start.argv.at(-1)))).toBeLessThanOrEqual(APP_SOURCE_TRANSPORT.helperJsonBytes);
    const frame = encodeGuestStart(start);
    expect(Buffer.byteLength(frame)).toBeGreaterThan(1048576);
    expect(Buffer.byteLength(frame)).toBeLessThan(APP_SOURCE_TRANSPORT.startFrameBytes);
    expect(Buffer.byteLength(start.prompt)).toBeLessThan(APP_SOURCE_TRANSPORT.requestBytes);
    const script = `import ast,json,sys,types
tree=ast.parse(sys.argv[1]); data=sys.stdin.buffer.read(); offset=[0]
nodes=[n for n in tree.body if (isinstance(n,ast.FunctionDef) and n.name=='read_start') or (isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='START_FRAME_BYTES' for t in n.targets))]
def read(fd,count):
    value=data[offset[0]:offset[0]+count]; offset[0]+=len(value); return value
scope={'os':types.SimpleNamespace(read=read),'json':json,'sys':types.SimpleNamespace(platform='linux',stdin=types.SimpleNamespace(fileno=lambda:0)),'ctypes':types.SimpleNamespace(CDLL=lambda *a,**k:types.SimpleNamespace(prctl=lambda *a:0))}
exec(compile(ast.Module(body=nodes,type_ignores=[]),'<real-start-reader>','exec'),scope)
start=scope['read_start'](); request=json.loads(start['prompt'])
assert offset[0]==len(data) and request['operation']=='import-source'
print(len(request['files']))`;
    expect(execFileSync('python3', ['-I', '-c', script, guestHelper], { input: frame, encoding: 'utf8', timeout: 3000 }).trim()).toBe(
      '256',
    );
  } finally {
    try {
      await service?.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
