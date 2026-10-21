import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EduTaskBinding } from '@wsl/protocol';
import { assertEduTaskSource, assertEduTaskCandidate, eduTaskMetadata } from './edu-task';
const files = [
  { path: 'admin/src/app.ts', base64: Buffer.from('a').toString('base64') },
  { path: 'server/app.py', base64: Buffer.from('protected').toString('base64') },
];
const metadata = eduTaskMetadata(files);
const binding: EduTaskBinding = {
  runId: crypto.randomUUID(),
  workspaceId: 'w',
  projectId: crypto.randomUUID(),
  appInstanceId: crypto.randomUUID(),
  resourceId: 'r',
  instanceId: 'i',
  generation: 1,
  webContentsId: 1,
  documentGeneration: 1,
  sourceSha256: createHash('sha256').update(JSON.stringify(metadata)).digest('hex'),
  protectedFiles: metadata.filter((f) => !f.path.startsWith('admin/src/')),
};
describe('edu task source gate', () => {
  it('allows only frontend changes against the frozen source', () => {
    expect(() => assertEduTaskSource(binding, files)).not.toThrow();
    expect(() =>
      assertEduTaskCandidate(binding, { runId: binding.runId, files: [{ ...files[0]!, base64: 'Yg==' }, files[1]!] }),
    ).not.toThrow();
  });
  it('rejects concurrent source edits, protected changes, deletion and wrong run', () => {
    expect(() => assertEduTaskSource(binding, [{ ...files[0]!, base64: 'Yg==' }, files[1]!])).toThrow('source changed');
    expect(() => assertEduTaskCandidate(binding, { runId: binding.runId, files: [files[0]!] })).toThrow('protected');
    expect(() => assertEduTaskCandidate(binding, { runId: crypto.randomUUID(), files })).toThrow('another run');
    expect(() =>
      assertEduTaskCandidate(binding, { runId: binding.runId, files: [...files, { path: 'server/new.py', base64: '' }] }),
    ).toThrow('protected');
  });
});
