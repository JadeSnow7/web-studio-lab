import { expect } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { isMotaExcludedName, isMotaSourcePath, MOTA_ROOT_DIRS } from '../packages/protocol/src';
import { motaBounded } from './mota-agent-live-helpers';

const exec = promisify(execFile);
export const motaHash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const Port = z.object({ host_ip: z.string(), host_port: z.number().int(), sandbox_port: z.number().int(), protocol: z.string() });
type Port = z.infer<typeof Port>;
const sortPorts = (ports: Port[]) => [...ports].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
export type MotaProcessIdentity = { pid: number; startTime: string };

export async function motaInputAudit(root: string) {
  const entries: Array<{ path: string; mode: number; sha256: string }> = [];
  const walk = async (relative: string) => {
    const full = path.join(root, relative);
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new Error('source audit refuses links');
    if (info.isDirectory()) {
      for (const name of (await readdir(full)).sort()) {
        if (isMotaExcludedName(name)) continue;
        const child = relative ? relative + '/' + name : name;
        if (MOTA_ROOT_DIRS.includes(child) || isMotaSourcePath(child)) await walk(child);
      }
    } else {
      if (!info.isFile() || info.nlink !== 1) throw new Error('source audit requires regular files with one link');
      entries.push({ path: relative, mode: info.mode, sha256: motaHash(await readFile(full)) });
    }
  };
  await walk('');
  return { sha256: motaHash(JSON.stringify(entries)), files: entries.length };
}

/** The single owned read-only session prevents auto-stop from masking leaked App processes or renumbering old mappings. */
export async function startMotaAuditLifetime(binary: string, sandbox: string) {
  const inspected = z
    .object({ state: z.enum(['stopped', 'running']), runtime_mounts: z.array(z.unknown()).optional() })
    .parse(JSON.parse((await exec(binary, ['inspect', '--json', sandbox], { timeout: 20_000 })).stdout));
  expect(inspected.runtime_mounts ?? []).toEqual([]);
  const keeper = spawn(
    binary,
    ['exec', '-i', sandbox, 'python3', '-u', '-c', "import sys;print('MOTA_AUDIT_ACTIVE',flush=True);sys.stdin.buffer.read()"],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 1_500_000,
    },
  );
  const inputErrors: string[] = [];
  keeper.stderr.resume();
  keeper.stdin.on('error', (error) => inputErrors.push(String(error)));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string }>((resolve) => {
    keeper.once('close', (code, signal) => resolve({ code, signal }));
    keeper.once('error', (error) => resolve({ code: null, signal: null, error: String(error) }));
  });
  const close = async () => {
    const errors: string[] = [];
    let result: unknown;
    try {
      expect(keeper.exitCode, 'audit keeper exited before final checks').toBeNull();
      expect(keeper.signalCode).toBeNull();
      keeper.stdin.end();
      result = await motaBounded(exited, 10_000, 'owned audit keeper EOF did not exit');
      expect(result).toEqual({ code: 0, signal: null });
      expect(inputErrors).toEqual([]);
    } catch (error) {
      errors.push(String(error));
      if (keeper.exitCode === null && keeper.signalCode === null) keeper.kill('SIGTERM');
      try {
        result = await motaBounded(exited, 10_000, 'owned audit keeper exit unconfirmed');
      } catch (error) {
        errors.push(String(error));
      }
    }
    return { pid: keeper.pid, result, errors };
  };
  try {
    await motaBounded(
      new Promise<void>((resolve, reject) => {
        let output = '';
        keeper.stdout.on('data', (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-1024);
          if (output.includes('MOTA_AUDIT_ACTIVE')) resolve();
        });
        keeper.once('error', reject);
        keeper.once('close', () => reject(new Error('audit keeper exited before readiness')));
      }),
      20_000,
      'audit keeper not ready',
    );
    const ports = async () => {
      if (keeper.exitCode !== null || keeper.signalCode !== null) throw new Error('audit keeper exited before ports read');
      return sortPorts(z.array(Port).parse(JSON.parse((await exec(binary, ['ports', sandbox, '--json'], { timeout: 15_000 })).stdout)));
    };
    const baseline = await ports();
    const assertBinding = async (origin: string, guestPort: number | null | undefined) => {
      const url = new URL(origin);
      if (!guestPort) throw new Error('managed guest port unavailable');
      expect(url.hostname).toBe('127.0.0.1');
      expect(url.protocol).toBe('http:');
      const binding = { host_ip: url.hostname, host_port: Number(url.port), sandbox_port: guestPort, protocol: 'tcp4' };
      expect(baseline.some((entry) => entry.host_port === binding.host_port || entry.sandbox_port === guestPort)).toBe(false);
      expect(await ports()).toEqual(sortPorts([...baseline, binding]));
      return binding;
    };
    return { initialState: inspected.state, keeperPid: keeper.pid, baseline, ports, assertBinding, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Reads only this new project's fixed MT1 and socket owners; never process argv, credentials or environment. */
export async function readMotaOwnedFloor(
  binary: string,
  sandbox: string,
  projectId: string,
  guestPort: number | null,
  expected: MotaProcessIdentity[] = [],
) {
  if (!/^[a-f0-9-]{36}$/.test(projectId)) throw new Error('invalid owned project');
  const script = `import os,sys,json,stat,hashlib,base64
root='/home/agent/workspace/.wsl-apps/'+sys.argv[1]
file=root+'/project/floors/MT1.js'
if os.path.realpath(root)!=root or os.path.realpath(file)!=file: raise RuntimeError('linked_source')
fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW)
try:
 s=os.fstat(fd)
 if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_size>1048576: raise RuntimeError('invalid_floor')
 with os.fdopen(fd,'rb',closefd=False) as stream: content=stream.read(1048577)
finally: os.close(fd)
port=json.loads(sys.argv[2]); expected=json.loads(sys.argv[3]); sockets=set(); processes=[]; remaining=[]
if port is not None:
 for table in ['/proc/net/tcp','/proc/net/tcp6']:
  try:
   with open(table) as stream:
    for line in stream.readlines()[1:]:
     row=line.split()
     if row[3]=='0A' and int(row[1].split(':')[-1],16)==port: sockets.add('socket:['+row[9]+']')
  except FileNotFoundError: pass
for pid in os.listdir('/proc'):
 if not pid.isdigit(): continue
 try:
  text=open('/proc/'+pid+'/stat').read(); tail=text[text.rfind(')')+2:].split(); identity={'pid':int(pid),'startTime':tail[19]}
  if identity in expected: remaining.append(identity)
  for fd in os.listdir('/proc/'+pid+'/fd') if sockets else []:
   try: owned=os.readlink('/proc/'+pid+'/fd/'+fd) in sockets
   except (FileNotFoundError,ProcessLookupError,PermissionError): continue
   if owned: processes.append(identity); break
 except (FileNotFoundError,ProcessLookupError,PermissionError): pass
print(json.dumps({'sha256':hashlib.sha256(content).hexdigest(),'base64':base64.b64encode(content).decode(),'processes':processes,'remaining':remaining}))`;
  const result = await exec(
    binary,
    ['exec', sandbox, 'python3', '-c', script, projectId, JSON.stringify(guestPort), JSON.stringify(expected)],
    { timeout: 30_000, maxBuffer: 2_500_000 },
  );
  const data = z
    .object({
      sha256: z.string(),
      base64: z.string().max(2_000_000),
      processes: z.array(z.object({ pid: z.number().int(), startTime: z.string() })),
      remaining: z.array(z.object({ pid: z.number().int(), startTime: z.string() })),
    })
    .parse(JSON.parse(result.stdout));
  const bytes = Buffer.from(data.base64, 'base64');
  expect(motaHash(bytes)).toBe(data.sha256);
  return { sha256: data.sha256, bytes, processes: data.processes, remaining: data.remaining };
}
