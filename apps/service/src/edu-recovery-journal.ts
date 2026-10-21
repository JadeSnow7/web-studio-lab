import { lstatSync } from 'node:fs';
import { constants } from 'node:fs';
import { open, mkdir, rename, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EduAdmissionRecoveryStatusSchema, EduVerificationStatusSchema, EduVerificationIdentitySchema } from '@wsl/protocol';
import { strictJson } from './edu-assessment';
import type { MaintenanceGate } from './maintenance-gate';
const loopback = z
  .string()
  .refine((value) => /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value) && Number(value.slice(value.lastIndexOf(':') + 1)) <= 65535);
export const RecoveryRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: EduVerificationStatusSchema,
    originalIdentity: EduVerificationIdentitySchema,
    restoreInstanceIds: z.array(EduVerificationIdentitySchema.shape.appInstanceId).max(16),
    urls: z.array(loopback).max(16),
    ownershipTaken: z.boolean(),
  })
  .strict()
  .refine(
    (r) =>
      r.originalIdentity.workspaceId === r.status.lease.identity.workspaceId &&
      r.originalIdentity.projectId === r.status.lease.identity.projectId,
  );
export type RecoveryRecord = z.infer<typeof RecoveryRecordSchema>;
export const AdmissionRecoveryRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    admissionOnly: z.literal(true),
    status: EduAdmissionRecoveryStatusSchema,
    restoreInstanceIds: z.array(EduVerificationIdentitySchema.shape.appInstanceId).min(1).max(16),
    urls: z.array(loopback).max(16),
  })
  .strict()
  .refine((record) => !record.status.restoredIdentity || record.restoreInstanceIds.includes(record.status.restoredIdentity.appInstanceId));
export type AdmissionRecoveryRecord = z.infer<typeof AdmissionRecoveryRecordSchema>;
const JournalRecordSchema = z.union([RecoveryRecordSchema, AdmissionRecoveryRecordSchema]);
type JournalRecord = z.infer<typeof JournalRecordSchema>;

export async function atomicPrivateJson(filename: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const parent = await lstat(path.dirname(filename));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o022) !== 0)
    throw new Error('verification_journal_invalid_directory');
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error('verification_journal_invalid_file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = filename + '.' + randomUUID() + '.tmp';
  let published = false;
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(JSON.stringify(value) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, filename);
    published = true;
    const directory = await open(path.dirname(filename), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (!published)
      await unlink(temporary).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
  }
}
export class RecoveryJournal {
  readonly required: boolean;
  private pending: Promise<void> = Promise.resolve();
  constructor(
    readonly filename: string,
    private gate: MaintenanceGate,
  ) {
    try {
      lstatSync(filename);
      this.required = true;
    } catch (error) {
      this.required = (error as NodeJS.ErrnoException).code !== 'ENOENT';
    }
    if (this.required) this.gate.acquire();
  }
  async open(): Promise<JournalRecord | null> {
    if (!this.required) return null;
    const parent = await lstat(path.dirname(this.filename));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o022) !== 0)
      throw new Error('verification_journal_invalid_directory');
    const file = await open(this.filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32768 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
        throw new Error('verification_journal_invalid_file');
      const body = await file.readFile('utf8');
      if (Buffer.byteLength(body) > 32768) throw new Error('verification_journal_budget');
      const record = JournalRecordSchema.parse(strictJson(body));
      return record;
    } finally {
      await file.close();
    }
  }
  write(value: JournalRecord): Promise<void> {
    const record = JournalRecordSchema.parse(value);
    const saving = this.pending.then(() => atomicPrivateJson(this.filename, record));
    this.pending = saving.then(
      () => undefined,
      () => undefined,
    );
    return saving;
  }
}
