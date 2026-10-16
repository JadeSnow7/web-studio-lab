import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { MAX_ASSESSMENT_RESULT, strictJson } from './edu-assessment';
const absolute = z
  .string()
  .max(4096)
  .refine((value) => path.isAbsolute(value) && [...value].every((char) => char.codePointAt(0)! >= 32 && char.codePointAt(0) !== 127));
const remotePath = z
  .string()
  .regex(/^\/[A-Za-z0-9_./-]+$/)
  .refine((value) => !value.split('/').includes('..'));
export const ProviderConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    host: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/),
    user: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/),
    identityFile: absolute,
    hostKeyAlias: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/),
    knownHostsFile: absolute,
    pythonExecutable: remotePath,
    providerPath: remotePath,
    bindInterface: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,31}$/)
      .optional(),
  })
  .strict();
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export async function loadProviderConfig(filename: string | undefined): Promise<ProviderConfig> {
  if (!filename || !path.isAbsolute(filename)) throw new Error('verification_provider_unconfigured');
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384 || (stat.mode & 0o022) !== 0 || stat.uid !== process.getuid?.())
      throw new Error('verification_invalid_provider_config');
    const content = await file.readFile('utf8');
    if (Buffer.byteLength(content) > 16384) throw new Error('verification_invalid_provider_config');
    return ProviderConfigSchema.parse(strictJson(content));
  } finally {
    await file.close();
  }
}
export function providerArgs(config: ProviderConfig): string[] {
  const c = ProviderConfigSchema.parse(config);
  return [
    '-F',
    '/dev/null',
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'UpdateHostKeys=no',
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    'PreferredAuthentications=publickey',
    '-o',
    'PasswordAuthentication=no',
    '-o',
    'KbdInteractiveAuthentication=no',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'PermitLocalCommand=no',
    '-o',
    'ProxyCommand=none',
    '-o',
    'ProxyJump=none',
    '-o',
    'IdentityAgent=none',
    '-o',
    'RequestTTY=no',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ServerAliveInterval=5',
    '-o',
    'ServerAliveCountMax=2',
    '-o',
    `HostKeyAlias=${c.hostKeyAlias}`,
    '-o',
    `UserKnownHostsFile=${c.knownHostsFile}`,
    '-i',
    c.identityFile,
    ...(c.bindInterface ? ['-o', `BindInterface=${c.bindInterface}`] : []),
    `${c.user}@${c.host}`,
    `'${c.pythonExecutable}' -B '${c.providerPath}'`,
  ];
}
export type ProviderRunner = (config: ProviderConfig, input: string, signal: AbortSignal) => Promise<Buffer>;
/** Resolve only after close, including cancellation; no child pipe escapes to ordinary logs. */
export function createProviderRunner(
  start: (args: string[]) => ChildProcessWithoutNullStreams = (args) =>
    spawn('/usr/bin/ssh', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C', HOME: process.env['HOME'] ?? '/' },
    }),
): ProviderRunner {
  return (config, input, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('assessment_provider_revoked'));
        return;
      }
      const child = start(providerArgs(config));
      let output = Buffer.alloc(0),
        failure: string | null = null;
      const kill = () => {
        failure ??= 'assessment_provider_revoked';
        child.kill('SIGKILL');
      };
      signal.addEventListener('abort', kill, { once: true });
      child.stdout.on('data', (data: Buffer) => {
        if (output.length + data.length > MAX_ASSESSMENT_RESULT) {
          failure = 'assessment_provider_budget';
          child.kill('SIGKILL');
        } else output = Buffer.concat([output, data]);
      });
      // Drain stderr without retaining even a tail: remote exceptions may contain secrets/audio.
      child.stderr.on('data', () => undefined);
      child.stdin.on('error', () => {
        failure ??= 'assessment_provider_disconnected';
      });
      child.on('error', () => {
        failure ??= 'assessment_provider_unavailable';
      });
      child.once('close', (code) => {
        signal.removeEventListener('abort', kill);
        if (failure || signal.aborted || (code !== 0 && code !== 1)) reject(new Error(failure ?? 'assessment_provider_failed'));
        else {
          try {
            const response = strictJson(output.toString('utf8'));
            if (
              !response ||
              typeof response !== 'object' ||
              !('ok' in response) ||
              typeof response.ok !== 'boolean' ||
              response.ok !== (code === 0)
            )
              throw new Error('assessment_provider_exit_mismatch');
            resolve(output);
          } catch {
            reject(new Error('assessment_provider_invalid_result'));
          }
        }
      });
      child.stdin.end(input);
      if (signal.aborted) kill();
    });
}
export const runProvider = createProviderRunner();
