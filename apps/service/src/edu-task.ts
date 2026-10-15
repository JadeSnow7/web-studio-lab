import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type EduTaskBinding, type AppSource } from '@wsl/protocol';
import { validateAppSources } from './app-service';
import type { GuestWorkspace } from './sbx';

export function eduTaskMetadata(files: AppSource['files']) {
  validateAppSources(files);
  return files
    .map((file) => {
      const bytes = Buffer.from(file.base64, 'base64');
      return { path: file.path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
export function assertEduTaskSource(binding: EduTaskBinding, files: AppSource['files']) {
  const metadata = eduTaskMetadata(files);
  if (createHash('sha256').update(JSON.stringify(metadata)).digest('hex') !== binding.sourceSha256)
    throw new Error('conflict: edu task source changed');
  if (JSON.stringify(metadata.filter((file) => !file.path.startsWith('admin/src/'))) !== JSON.stringify(binding.protectedFiles))
    throw new Error('conflict: edu task protected manifest changed');
}
export function assertEduTaskCandidate(binding: EduTaskBinding, candidate: GuestWorkspace) {
  if (candidate.runId !== binding.runId) throw new Error('conflict: edu candidate belongs to another run');
  const metadata = eduTaskMetadata(candidate.files);
  if (JSON.stringify(metadata.filter((file) => !file.path.startsWith('admin/src/'))) !== JSON.stringify(binding.protectedFiles))
    throw new Error('denied: edu task changed protected files');
}
export class EduTaskCandidates {
  private readonly candidates = new Map<string, { binding: EduTaskBinding; candidate: GuestWorkspace }>();
  constructor(private readonly root: string) {}
  async retain(binding: EduTaskBinding, candidate: GuestWorkspace) {
    const directory = path.join(this.root, 'edu-task-candidates');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Persist even rejected inventories for diagnosis; never materialize untrusted paths.
    await writeFile(path.join(directory, binding.runId + '.json'), JSON.stringify({ binding, candidate }), { flag: 'wx', mode: 0o600 });
    this.candidates.set(binding.runId, { binding: structuredClone(binding), candidate: structuredClone(candidate) });
  }
  get(binding: EduTaskBinding) {
    const saved = this.candidates.get(binding.runId);
    if (!saved || JSON.stringify(saved.binding) !== JSON.stringify(binding)) throw new Error('conflict: edu candidate binding mismatch');
    assertEduTaskCandidate(binding, saved.candidate);
    return saved.candidate;
  }
}
