import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { AppSourceFileSchema } from '@wsl/protocol';
import helper from './guest-helper.py?raw';

// Compile only the real pure snapshot functions. No Linux process setup,
// read_start, guest, model, or lifecycle replacement runs on this host.
const harness = String.raw`
import ast,base64,io,json,os,sys,tempfile
from pathlib import Path
from types import SimpleNamespace
request=json.load(sys.stdin)
tree=ast.parse(request['helper'])
names={'workspace_path','workspace_snapshot_limits','snapshot_workspace'}
nodes=[node for node in tree.body if
       (isinstance(node,ast.FunctionDef) and node.name in names) or
       (isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='WORKSPACE_BYTES' for target in node.targets))]
frames=[]
scope={'os':os,'base64':base64,'emit':lambda kind,**fields: frames.append({'type':kind,**fields})}
exec(compile(ast.Module(body=nodes,type_ignores=[]),'<actual-guest-snapshot>','exec'),scope)
stats={'opened':0,'closed':0,'yielded':0}
class Entry:
    def __init__(self,name,parent='/snapshot',kind='directory'):
        self.name=name;self.path=os.path.join(parent,name);self.kind=kind
    def is_symlink(self): return self.kind=='symlink'
    def is_dir(self,*,follow_symlinks):
        assert follow_symlinks is False
        return self.kind=='directory'
    def is_file(self,*,follow_symlinks):
        assert follow_symlinks is False
        return self.kind=='file'
class Scan:
    def __init__(self,entries):
        self.entries=iter(entries);self.closed=False;stats['opened']+=1
    def __iter__(self): return self
    def __next__(self):
        value=next(self.entries);stats['yielded']+=1;return value
    def __enter__(self): return self
    def __exit__(self,*ignored):
        assert not self.closed
        self.closed=True;stats['closed']+=1
def configure(scanner,path_max=4):
    scope['os']=SimpleNamespace(path=os.path,scandir=scanner,pathconf=lambda root,key:path_max)
def attempt():
    try:
        scope['snapshot_workspace']('/snapshot','00000000-0000-4000-8000-000000000001')
        return None
    except (ValueError,OSError,RuntimeError) as error:
        return {'type':type(error).__name__,'message':str(error)}
`;

function run(script: string): unknown {
  const result = execFileSync('python3', ['-I', '-c', harness + '\n' + script], {
    input: JSON.stringify({ helper }),
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: 3000,
  });
  return JSON.parse(result) as unknown;
}

it('rejects excess enumeration before materializing the directory and closes its scanner', () => {
  // A deliberately small filesystem path limit exercises the exact production
  // formula without allocating a production-sized hostile directory.
  expect(
    run(String.raw`
limit=256*(4//2)+3
def entries():
    for index in range(limit+2):
        if index==limit+1: raise RuntimeError('unbounded enumeration sentinel')
        yield Entry('entry-'+str(index))
configure(lambda directory:Scan(entries()))
error=attempt()
print(json.dumps({'error':error,'stats':stats,'frames':frames}))
`),
  ).toEqual({
    error: { type: 'ValueError', message: 'guest workspace snapshot exceeds enumeration budget' },
    stats: { opened: 1, closed: 1, yielded: 516 },
    frames: [],
  });
});

it('shares the enumeration budget across directories including empty directories', () => {
  expect(
    run(String.raw`
def scan(directory):
    if directory=='/snapshot': return Scan([Entry('b'),Entry('a')])
    if directory in ('/snapshot/a','/snapshot/b'):
        return Scan(Entry(str(index),directory) for index in range(257))
    return Scan([])
configure(scan)
error=attempt()
print(json.dumps({'error':error,'closed':stats['opened']==stats['closed'],'yielded':stats['yielded'],'frames':frames}))
`),
  ).toEqual({
    error: { type: 'ValueError', message: 'guest workspace snapshot exceeds enumeration budget' },
    closed: true,
    yielded: 516,
    frames: [],
  });
});

it('counts excluded root names before discarding them and closes on iterator failure', () => {
  expect(
    run(String.raw`
def entries():
    yield Entry('node_modules')
    yield Entry('dist')
    yield Entry('.vite')
    for index in range(513): yield Entry('entry-'+str(index))
configure(lambda directory:Scan(entries()))
budget=attempt()
budget_stats=dict(stats)
stats.update(opened=0,closed=0,yielded=0)
def broken():
    yield Entry('a')
    raise OSError('iterator failed')
configure(lambda directory:Scan(broken()))
failure=attempt()
print(json.dumps({'budget':budget,'budgetStats':budget_stats,'failure':failure,'failureStats':stats,'frames':frames}))
`),
  ).toEqual({
    budget: { type: 'ValueError', message: 'guest workspace snapshot exceeds enumeration budget' },
    budgetStats: { opened: 1, closed: 1, yielded: 516 },
    failure: { type: 'OSError', message: 'iterator failed' },
    failureStats: { opened: 1, closed: 1, yielded: 1 },
    frames: [],
  });
});

it('derives production limits from the filesystem rather than a new 500-character path restriction', () => {
  const result = z.object({ limits: z.array(z.array(z.number())), actualPathMax: z.number(), actualLimits: z.array(z.number()) }).parse(
    run(String.raw`
limits=[]
for maximum in (500,1024,4096):
    configure(lambda directory:Scan([]),maximum)
    limits.append(scope['workspace_snapshot_limits']('/snapshot'))
with tempfile.TemporaryDirectory() as root:
    scope['os']=os
    maximum=os.pathconf(root,'PC_PATH_MAX')
    actual=scope['workspace_snapshot_limits'](root)
print(json.dumps({'limits':limits,'actualPathMax':maximum,'actualLimits':actual}))
`),
  );
  expect(result.limits).toEqual([
    [250, 64003],
    [512, 131075],
    [2048, 524291],
  ]);
  const components = Math.floor(result.actualPathMax / 2);
  expect(result.actualLimits).toEqual([components, 256 * components + 3]);
});

it.each(['unknown', 'failure'])('fails explicitly before scanning when PATH_MAX is %s', (mode) => {
  expect(
    run(String.raw`
def path_limit(root,key):
    if ${JSON.stringify(mode)}=='failure': raise OSError('pathconf failed')
    return -1
scope['os']=SimpleNamespace(path=os.path,pathconf=path_limit,scandir=lambda directory:Scan([]))
print(json.dumps({'error':attempt(),'stats':stats,'frames':frames}))
`),
  ).toEqual({
    error: { type: 'ValueError', message: 'guest workspace filesystem path limit unavailable' },
    stats: { opened: 0, closed: 0, yielded: 0 },
    frames: [],
  });
});

it('retains 256 files at 500 UTF-16 units and the complete decoded byte budget', () => {
  // Virtual DirEntry/reader adapters avoid creating 64,000 on-disk entries.
  // Every path is valid under the real AppSourceFile schema; the production
  // snapshot function still enumerates all 64,000 actual fixture entries.
  const paths = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, '0') + '/' + 'a/'.repeat(248) + 'b');
  const content = Buffer.alloc(2048, 120);
  const expected = paths.map((path) => AppSourceFileSchema.parse({ path, base64: content.toString('base64') }));
  expect(expected.every((file) => file.path.length === 500)).toBe(true);
  const result = z
    .object({
      error: z.null(),
      stats: z.object({ opened: z.number(), closed: z.number(), yielded: z.number() }),
      frames: z.array(z.object({ type: z.literal('workspace'), runId: z.string(), files: z.array(AppSourceFileSchema) })),
    })
    .parse(
      run(String.raw`
def scan(directory):
    if directory=='/snapshot': return Scan(Entry(format(index,'02x')) for index in reversed(range(256)))
    depth=len(directory[len('/snapshot/'):].split('/'))
    return Scan([Entry('a' if depth<249 else 'b',directory,'directory' if depth<249 else 'file')])
configure(scan,1024)
scope['open']=lambda filename,mode:io.BytesIO(b'x'*2048)
error=attempt()
print(json.dumps({'error':error,'stats':stats,'frames':frames}))
`),
    );
  expect(result.stats.yielded).toBe(64000);
  expect(result.stats.closed).toBe(result.stats.opened);
  expect(result.frames).toHaveLength(1);
  const frame = result.frames[0];
  if (!frame) throw new Error('Missing workspace snapshot');
  expect(frame.files.map((file) => file.path)).toEqual(paths);
  expect(frame.files.every((file) => Buffer.from(file.base64, 'base64').equals(content))).toBe(true);
  expect(frame.files.reduce((total, file) => total + Buffer.from(file.base64, 'base64').length, 0)).toBe(524288);
});

it('keeps real-file bytes, deterministic order and root-only exclusions, then rejects a symlink', () => {
  expect(
    run(String.raw`
with tempfile.TemporaryDirectory() as root:
    base=Path(root)
    for name in ('node_modules','dist','.vite'):
        (base/name).mkdir();(base/name/'ignored').write_bytes(b'ignored')
    (base/'z').write_bytes(bytes([0,255]))
    (base/'a'/'node_modules').mkdir(parents=True)
    (base/'a'/'node_modules'/'keep').write_bytes(b'nested')
    (base/'a'/'empty').write_bytes(b'')
    (base/'a.ts').write_bytes(b'sibling')
    scope['snapshot_workspace'](root,'00000000-0000-4000-8000-000000000001')
    first=frames.pop()
    (base/'link').symlink_to(base/'z')
    try:
        scope['snapshot_workspace'](root,'00000000-0000-4000-8000-000000000001')
        failure=None
    except ValueError as error: failure=str(error)
print(json.dumps({'files':first['files'],'failure':failure,'frames':frames}))
`),
  ).toEqual({
    files: [
      { path: 'a/empty', base64: '' },
      { path: 'a/node_modules/keep', base64: Buffer.from('nested').toString('base64') },
      { path: 'a.ts', base64: Buffer.from('sibling').toString('base64') },
      { path: 'z', base64: Buffer.from([0, 255]).toString('base64') },
    ],
    failure: 'guest workspace symlink: link',
    frames: [],
  });
});

it('preserves real workspace paths longer than the separate AppSource 500-unit limit', () => {
  const relative = ('a'.repeat(99) + '/').repeat(5) + 'b'.repeat(100);
  expect(relative).toHaveLength(600);
  expect(
    run(String.raw`
with tempfile.TemporaryDirectory() as root:
    relative=('a'*99+'/')*5+'b'*100
    destination=Path(root)/relative
    assert len(os.fsencode(destination)) < os.pathconf(root,'PC_PATH_MAX')
    destination.parent.mkdir(parents=True)
    destination.write_bytes(b'long path')
    scope['snapshot_workspace'](root,'00000000-0000-4000-8000-000000000001')
print(json.dumps(frames))
`),
  ).toEqual([
    {
      type: 'workspace',
      runId: '00000000-0000-4000-8000-000000000001',
      files: [{ path: relative, base64: Buffer.from('long path').toString('base64') }],
    },
  ]);
});
