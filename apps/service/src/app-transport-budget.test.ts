import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { APP_SOURCE_TRANSPORT, AppImportRequestSchema, EDU_REQUIRED_FILES, type AppImportRequest } from '@wsl/protocol';
import { AppService } from './app-service';
import { encodeGuestStart, GuestProcess, type GuestFrame, type GuestStart } from './sbx';
import helper from './app-helper.py?raw';
import guestHelper from './guest-helper.py?raw';

const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
function request(character = '中'): AppImportRequest {
  const names = [...EDU_REQUIRED_FILES];
  for (let index = 0; index < 250; index++)
    names.push('admin/src/' + (character.repeat(50) + '/').repeat(8) + character.repeat(75) + String(index).padStart(4, '0') + '.ts');
  const required: Record<string, string> = {
    'admin/package.json': JSON.stringify({ scripts: { build: 'node -e ""', typecheck: 'node -e ""' } }),
    'admin/package-lock.json': '{"lockfileVersion":3,"packages":{}}',
    'server/app.py': '# transport fixture\n',
    'server/wsl_runtime.py': '# transport fixture\n',
    'server/requirements.lock': '# no dependencies\n',
    'server/requirements-test.lock': '# no dependencies\n',
  };
  let remaining = 524288 - Object.values(required).reduce((sum, value) => sum + Buffer.byteLength(value), 0);
  const files = names.sort().map((path) => {
    const requiredContent = required[path];
    const content = requiredContent === undefined ? Buffer.alloc(remaining, 120) : Buffer.from(requiredContent);
    if (!(path in required)) remaining = 0;
    return { path, base64: content.toString('base64') };
  });
  const metadata = files.map((file) => {
    const bytes = Buffer.from(file.base64, 'base64');
    return { path: file.path, sha256: hash(bytes), bytes: bytes.length };
  });
  return AppImportRequestSchema.parse({
    workspaceId: 'transport-budget',
    projectId: '128ff490-fde9-40d1-a7ee-0f4b55c2d8a5',
    importOperationId: 'b9505f08-bd69-4f99-917c-ea8debc6d048',
    files,
    source: { repository: { commit: 'a'.repeat(40), dirty: true }, files: metadata, sourceSha256: hash(JSON.stringify(metadata)) },
  });
}

function output(value: unknown): string {
  return execFileSync(
    'python3',
    [
      '-I',
      '-c',
      "import ast,json,sys; tree=ast.parse(sys.argv[1]); node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='output'); scope={'json':json}; exec(compile(ast.Module(body=[node],type_ignores=[]),'<actual-app-output>','exec'),scope); scope['output'](json.load(sys.stdin))",
      helper,
    ],
    { input: JSON.stringify(value), encoding: 'utf8', maxBuffer: 3 * 1024 * 1024, timeout: 3000 },
  );
}

it('accepts the actual Python success receipt for the complete Unicode inventory', async () => {
  const input = request();
  const profile = { projectKind: 'edu-web', profileVersion: 1, source: input.source };
  const receipt = output({
    outcome: 'imported',
    retryable: false,
    errorCode: null,
    importOperationId: input.importOperationId,
    profile,
    sourceSha256: input.source.sourceSha256,
  });
  const exported = output({ files: input.files });
  expect(Buffer.byteLength(exported)).toBeGreaterThan(APP_SOURCE_TRANSPORT.importResultBytes);
  expect(Buffer.byteLength(receipt)).toBeGreaterThan(262144);
  expect(Buffer.byteLength(receipt)).toBeLessThan(1048576);
  const starts: GuestStart[] = [];
  const service = new AppService({
    getStatus: () => ({ available: true, sandbox: 'fixture', reason: null, version: 'fixture', cwd: '/home/agent/workspace' }),
    runtimeTarget: () => {
      throw new Error('No guest permitted');
    },
    start: (start, emit) => {
      starts.push(start);
      const operation = start.mode === 'codex' && start.prompt ? JSON.parse(start.prompt).operation : null;
      emit({ type: 'output', stream: 'stdout', data: operation === 'export' ? exported : receipt });
      const done = { confirmed: true, exitCode: 0, error: null };
      return { done: Promise.resolve(done), close: async () => done };
    },
  });
  try {
    const result = await service.importSource(input);
    expect(result.outcome).toBe('imported');
    expect(result.app?.profile).toEqual(profile);
    expect(starts).toHaveLength(1);
    const importedStart = starts[0];
    if (!importedStart) throw new Error('Missing import start');
    expect(Buffer.byteLength(encodeGuestStart(importedStart))).toBeLessThanOrEqual(APP_SOURCE_TRANSPORT.startFrameBytes);
    const source = await service.export({ workspaceId: input.workspaceId, projectId: input.projectId });
    expect(source.profile).toEqual(profile);
    expect(source.files).toEqual(input.files);
    expect(source.sha256).toBe(hash(JSON.stringify(input.files)));
    expect(starts).toHaveLength(2);
    expect(starts.every((start) => Buffer.byteLength(encodeGuestStart(start)) <= APP_SOURCE_TRANSPORT.startFrameBytes)).toBe(true);
  } finally {
    await service.shutdown();
  }
});

it('bounds every encoding layer over the full file/content/path domain without changing source limits', () => {
  const count = 256,
    pathUnits = 500;
  const base64Bytes = 4 * Math.floor((524288 + 2 * count) / 3);
  const inner = count * (2 * 6 * pathUnits + 102 + 23 + 2) + base64Bytes + 8192;
  const outer = count * (2 * 7 * pathUnits + 2 * 102 + 2 * 23 + 2) + base64Bytes + 16384 + APP_SOURCE_TRANSPORT.helperJsonBytes;
  const receipt = count * (6 * pathUnits + 102 + 1) + 8192;
  expect({ base64Bytes, inner, outer, receipt }).toEqual({ base64Bytes: 699732, inner: 2276436, outer: 2703700, receipt: 802560 });
  expect(inner).toBeLessThan(APP_SOURCE_TRANSPORT.requestBytes);
  expect(outer).toBeLessThan(APP_SOURCE_TRANSPORT.startFrameBytes);
  expect(receipt).toBeLessThan(APP_SOURCE_TRANSPORT.importResultBytes);
  const paddedLengths = Array.from({ length: count }, (_, index) => (index === count - 1 ? 524288 - count + 1 : 1));
  expect(paddedLengths.reduce((sum, length) => sum + Buffer.alloc(length).toString('base64').length, 0)).toBe(base64Bytes);
  for (const character of ['中', '"']) {
    const input = request(character);
    expect(Math.max(...input.files.map((file) => file.path.length))).toBe(500);
    expect(input.files.every((file) => file.path.split('/').every((part) => Buffer.byteLength(part) <= 255))).toBe(true);
    expect(input.files).toHaveLength(256);
    expect(input.source.files.reduce((sum, file) => sum + file.bytes, 0)).toBe(524288);
    const grown = structuredClone(input);
    const file = grown.files.find((file) => file.base64.length > 1000);
    if (!file) throw new Error('Missing payload fixture');
    file.base64 = Buffer.concat([Buffer.from(file.base64, 'base64'), Buffer.from([0])]).toString('base64');
    expect(AppImportRequestSchema.safeParse(grown).success).toBe(false);
    expect(AppImportRequestSchema.safeParse({ ...input, files: [...input.files, { path: 'admin/extra.ts', base64: '' }] }).success).toBe(
      false,
    );
  }
});

it('enforces exact start UTF-8 bytes including LF at the boundary', () => {
  const start: GuestStart = { type: 'start', mode: 'codex', argv: ['python3'], prompt: '' };
  const overhead = Buffer.byteLength(encodeGuestStart(start));
  start.prompt = 'x'.repeat(APP_SOURCE_TRANSPORT.startFrameBytes - overhead);
  expect(Buffer.byteLength(encodeGuestStart(start))).toBe(APP_SOURCE_TRANSPORT.startFrameBytes);
  start.prompt += 'x';
  expect(() => encodeGuestStart(start)).toThrow('guest start frame exceeds budget');
  start.prompt = '中'.repeat(APP_SOURCE_TRANSPORT.startFrameBytes / 3);
  expect(() => encodeGuestStart(start)).toThrow('guest start frame exceeds budget');
  // Isolated surrogates exercise JSON encoding only; they are not legal filesystem sources.
  for (const text of ['中', '😀', '\ud800', '"', '\\']) {
    start.prompt = text.repeat(500);
    const encoded = encodeGuestStart(start);
    expect(JSON.parse(encoded).prompt).toBe(start.prompt);
    expect(Buffer.byteLength(JSON.stringify(start.prompt))).toBeLessThanOrEqual(start.prompt.length * 6 + 2);
  }
});

it('keeps the real Python start/request limits synchronized and never consumes following control input', () => {
  const script = `import ast,io,json,sys,types
guest,app=sys.argv[1:]
tree=ast.parse(guest)
constant=next(n for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='START_FRAME_BYTES' for t in n.targets))
function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='read_start')
scope={'json':json,'ctypes':types.SimpleNamespace(CDLL=lambda *a,**k:types.SimpleNamespace(prctl=lambda *a:0)),'sys':types.SimpleNamespace(platform='linux',stdin=types.SimpleNamespace(fileno=lambda:0))}
exec(compile(ast.Module(body=[constant,function],type_ignores=[]),'<real-start-reader>','exec'),scope)
app_constant=next(n for n in ast.parse(app).body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='REQUEST_BYTES' for t in n.targets))
exec(compile(ast.Module(body=[app_constant],type_ignores=[]),'<real-request-limit>','exec'),scope)
limit=scope['START_FRAME_BYTES']
base=b'{"type":"start","mode":"codex","argv":[],"prompt":""}\\n'
following=b'{"type":"close"}\\n'
for delta in (0,1):
    frame=base[:-3]+b'x'*(limit-len(base)+delta)+base[-3:]
    stream=io.BytesIO(frame+following)
    scope['os']=types.SimpleNamespace(read=lambda fd,count:stream.read(count))
    if delta==0:
        assert scope['read_start']()['type']=='start'
        assert stream.read()==following
    else:
        try: scope['read_start']()
        except ValueError as error: assert str(error)=='start frame too large'
        else: raise AssertionError('oversize accepted')
        assert stream.tell()==limit+1
print(json.dumps({'start':limit,'request':scope['REQUEST_BYTES'],'followingPreserved':True}))`;
  const result = JSON.parse(execFileSync('python3', ['-I', '-c', script, guestHelper, helper], { encoding: 'utf8', timeout: 3000 }));
  expect(result).toEqual({
    start: APP_SOURCE_TRANSPORT.startFrameBytes,
    request: APP_SOURCE_TRANSPORT.requestBytes,
    followingPreserved: true,
  });
});

it('runs the real app request reader at its exact limit and refuses limit plus one before dispatch', () => {
  const script = `import ast,io,json,sys,types
tree=ast.parse(sys.argv[1])
constant=next(n for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='REQUEST_BYTES' for t in n.targets))
entry=next(n for n in tree.body if isinstance(n,ast.If) and isinstance(n.test,ast.Compare) and isinstance(n.test.left,ast.Name) and n.test.left.id=='__name__')
scope={'__name__':'__main__','json':json}
exec(compile(ast.Module(body=[constant],type_ignores=[]),'<request-limit>','exec'),scope)
limit=scope['REQUEST_BYTES']; base=b'{"operation":"fixture","padding":""}\\n'
for delta in (0,1):
    data=base[:-3]+b'x'*(limit-len(base)+delta)+base[-3:]; calls=[]
    scope['sys']=types.SimpleNamespace(argv=['app-helper'],stdin=types.SimpleNamespace(buffer=io.BytesIO(data)))
    scope['run']=lambda request:calls.append(request['operation'])
    try: exec(compile(ast.Module(body=[entry],type_ignores=[]),'<real-app-entry>','exec'),scope)
    except ValueError as error:
        assert delta==1 and str(error)=='app request exceeds budget'
        assert calls==[]
    else: assert delta==0 and calls==['fixture']
print('exact-request-budget-confirmed')`;
  expect(execFileSync('python3', ['-I', '-c', script, helper], { encoding: 'utf8', timeout: 3000 })).toContain(
    'exact-request-budget-confirmed',
  );
});

it.each([0, 1])('enforces the aggregate import receipt byte limit plus %i', async (extra) => {
  const input = request();
  const receipt =
    'WSL_APP_RESULT:' +
    JSON.stringify({
      outcome: 'imported',
      retryable: false,
      errorCode: null,
      importOperationId: input.importOperationId,
      profile: { projectKind: 'edu-web', profileVersion: 1, source: input.source },
      sourceSha256: input.source.sourceSha256,
    });
  const padding = ' '.repeat(APP_SOURCE_TRANSPORT.importResultBytes - Buffer.byteLength(receipt) - 1 + extra);
  const service = new AppService({
    getStatus: () => ({ available: true, sandbox: 'fixture', reason: null, version: 'fixture', cwd: '/home/agent/workspace' }),
    runtimeTarget: () => {
      throw new Error('No guest permitted');
    },
    start: (_start, emit) => {
      emit({ type: 'output', stream: 'stdout', data: receipt });
      emit({ type: 'output', stream: 'stdout', data: padding + '\n' });
      const done = { confirmed: true, exitCode: 0, error: null };
      return { done: Promise.resolve(done), close: async () => done };
    },
  });
  try {
    const result = await service.importSource(input);
    expect(result.outcome).toBe(extra === 0 ? 'imported' : 'failed');
    if (extra !== 0) expect(result).toMatchObject({ app: null, errorCode: 'import_cleanup_unknown' });
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

it.each(['aggregate-overflow', 'unbounded-error-code'])('refuses %s without publishing an import', async (fault) => {
  const input = request();
  let closeCalls = 0;
  const service = new AppService({
    getStatus: () => ({ available: true, sandbox: 'fixture', reason: null, version: 'fixture', cwd: '/home/agent/workspace' }),
    runtimeTarget: () => {
      throw new Error('No guest permitted');
    },
    start: (_start, emit) => {
      if (fault === 'aggregate-overflow') {
        emit({ type: 'output', stream: 'stdout', data: 'x'.repeat(APP_SOURCE_TRANSPORT.importResultBytes) });
        emit({ type: 'output', stream: 'stdout', data: '\n' });
      } else
        emit({
          type: 'output',
          stream: 'stdout',
          data: output({
            outcome: 'failed',
            retryable: false,
            errorCode: 'import_' + 'x'.repeat(94),
            importOperationId: input.importOperationId,
          }),
        });
      const done = { confirmed: true, exitCode: 0, error: null };
      return {
        done: Promise.resolve(done),
        close: async () => {
          closeCalls++;
          return done;
        },
      };
    },
  });
  try {
    expect(await service.importSource(input)).toMatchObject({ app: null, outcome: 'failed', errorCode: 'import_cleanup_unknown' });
  } finally {
    // Invalid receipts remain conservatively unresolved; no real worker exists in this fixture.
    await service.shutdown().catch(() => undefined);
  }
  expect(closeCalls).toBe(0);
});

it('rejects an oversized serialized start before spawning any process', async () => {
  let child: GuestProcess | undefined;
  try {
    expect(() => {
      child = new GuestProcess(
        '/not-a-real-guest-binary',
        'fixture',
        { type: 'start', mode: 'codex', argv: ['unused'], prompt: '中'.repeat(1048576) },
        (_frame: GuestFrame) => undefined,
      );
    }).toThrow('guest start frame exceeds budget');
  } finally {
    await child?.done;
  }
});
