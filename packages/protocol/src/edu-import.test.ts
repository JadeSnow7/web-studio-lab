import { describe, expect, it } from 'vitest';
import { AppImportRequestSchema } from './app-import';
import { AppProfileSchema, AppSourceSchema } from './managed-app';
import { ChatSendSchema } from './chat';

const target = {
  workspaceId: 'edu-fixture',
  projectId: '11111111-1111-4111-8111-111111111111',
  importOperationId: '22222222-2222-4222-8222-222222222222',
};
const source = {
  repository: { commit: 'a'.repeat(40), dirty: false },
  sourceSha256: 'b'.repeat(64),
  files: [{ path: 'admin/src/App.tsx', sha256: 'c'.repeat(64), bytes: 0 }],
};
const request = () => ({ ...target, source: structuredClone(source), files: [{ path: 'admin/src/App.tsx', base64: '' }] });
describe('edu-only import protocol boundary', () => {
  it('accepts an explicit edu import while refusing renderer paths and alternative profile requests', () => {
    expect(AppImportRequestSchema.safeParse(request()).success).toBe(true);
    expect(AppImportRequestSchema.safeParse({ ...request(), directory: '/unselected/host' }).success).toBe(false);
    expect(AppImportRequestSchema.safeParse({ ...request(), profile: 'mota-web' }).success).toBe(false);
    expect(AppProfileSchema.safeParse({ projectKind: 'edu-web', profileVersion: 1, source }).success).toBe(true);
    expect(AppProfileSchema.safeParse({ projectKind: 'edu-web', profileVersion: 2, source }).success).toBe(false);
  });
  it.each(['count', 'decoded-bytes', 'invalid-base64', 'metadata-bytes', 'duplicate-metadata', 'secret-path'])(
    'rejects %s before either import or export can dispatch',
    (kind) => {
      const input = request();
      if (kind === 'count') input.files = Array.from({ length: 257 }, (_, index) => ({ path: `admin/src/${index}.ts`, base64: '' }));
      if (kind === 'decoded-bytes') input.files[0] = { path: 'admin/src/App.tsx', base64: 'AAAA'.repeat(174763) };
      if (kind === 'invalid-base64') input.files[0] = { path: 'admin/src/App.tsx', base64: '*===' };
      if (kind === 'metadata-bytes')
        input.source.files[0] = { ...source.files[0], path: 'admin/src/App.tsx', sha256: 'c'.repeat(64), bytes: 524289 };
      if (kind === 'duplicate-metadata') input.source.files.push({ path: 'admin/src/App.tsx', sha256: 'c'.repeat(64), bytes: 0 });
      if (kind === 'secret-path') input.source.files[0] = { path: 'server/.env.py', sha256: 'c'.repeat(64), bytes: 0 };
      expect(AppImportRequestSchema.safeParse(input).success).toBe(false);
      expect(
        AppSourceSchema.safeParse({
          files: input.files,
          sha256: 'd'.repeat(64),
          profile: { projectKind: 'edu-web', profileVersion: 1, source: input.source },
        }).success,
      ).toBe(false);
    },
  );
  it('does not accept a fabricated future task capability in the send envelope', () => {
    const valid = {
      conversationId: 'conv-personal-default',
      text: 'run task',
      references: {
        accountId: 'account-fixture',
        workspaceId: null,
        sessionId: 'conv-personal-default',
        catalogRevision: 0,
        resources: [],
      },
    };
    expect(ChatSendSchema.safeParse(valid).success).toBe(true);
    const result = ChatSendSchema.safeParse({ ...valid, eduTask: { authority: true } });
    expect(result.success).toBe(false);
  });
});
