import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CatalogReferenceSnapshot, ResearchCapture, ResearchGrant, ResearchRunState } from '@wsl/protocol';
import { ResearchOwners, assertResearchBudget, assertResearchHistory } from './research';

const grant = (): ResearchGrant => ({
  grantId: randomUUID(),
  accountId: 'account',
  workspaceId: 'workspace',
  sessionId: 'session',
  taskVersionId: 'version',
  runId: randomUUID(),
  mode: 'live',
  purpose: 'public-web-research',
  grantedAt: new Date().toISOString(),
});
const capture = (text = 'body'): ResearchCapture => ({
  captureId: randomUUID(),
  readerResourceId: 'reader',
  requestedUrl: 'https://www.wikipedia.org/',
  url: 'https://www.wikipedia.org/',
  title: 'article',
  capturedAt: new Date().toISOString(),
  sourceSha256: 'a'.repeat(64),
  contentSha256: createHash('sha256').update(text).digest('hex'),
  extractionVersion: 'html-text-v1',
  truncated: false,
  textBytes: Buffer.byteLength(text),
  text,
  page: { webContentsId: 1, documentGeneration: 1, url: 'https://www.wikipedia.org/', title: 'article', partition: 'reader' },
});
const state = (): ResearchRunState => ({ grant: grant(), captures: [], inclusions: [] });

describe('bounded Main research ownership and history', () => {
  it('requires full immutable grant identity and keeps revoked in-flight ownership until drain', () => {
    const owners = new ResearchOwners(),
      identity = grant();
    const context = { grant: identity, generation: 'g', turnId: 't' };
    owners.register(identity);
    const owner = owners.get(context);
    owner.pending++;
    expect(() => owners.get({ ...context, grant: { ...identity, accountId: 'foreign' } })).toThrow('授权');
    owners.revoke(identity.runId, 'foreign');
    expect(owner.controller.signal.aborted).toBe(false);
    owners.revoke(identity.runId);
    expect(owner.controller.signal.aborted).toBe(true);
    owners.forget(identity.runId);
    expect(owners.hasPending(identity.runId)).toBe(true);
    expect(() => owners.get(context)).toThrow('撤销');
    owner.pending--;
    owners.forget(identity.runId);
    expect(owners.hasPending(identity.runId)).toBe(false);
    expect(() => owners.get(context)).toThrow('授权');
  });
  it('charges initial references, sealed captures and open reservations to the same count', () => {
    const research = state();
    research.captures = Array.from({ length: 15 }, () => capture());
    const references = { resources: [{}] } as CatalogReferenceSnapshot;
    expect(() => assertResearchBudget(research, references)).not.toThrow();
    expect(() => assertResearchBudget(research, references, 1)).toThrow('预算');
    expect(() => assertResearchBudget(research, undefined, 2)).toThrow('预算');
  });
  it('charges UTF-8 full JSON bytes including metadata instead of only text', () => {
    const research = state();
    research.captures = Array.from({ length: 8 }, () => capture('字'.repeat(21845)));
    expect(research.captures.reduce((sum, item) => sum + item.textBytes, 0)).toBeLessThan(512 * 1024);
    expect(() => assertResearchBudget(research)).toThrow('预算');
    research.captures.pop();
    expect(() => assertResearchHistory(research)).not.toThrow();
  });
  it.each(['hash', 'bytes', 'page', 'inclusion', 'duplicate'] as const)('rejects corrupt persisted %s evidence', (kind) => {
    const research = state(),
      source = capture();
    research.captures.push(source);
    if (kind === 'hash') source.contentSha256 = 'b'.repeat(64);
    if (kind === 'bytes') source.textBytes++;
    if (kind === 'page') {
      source.page.documentGeneration = 2;
      source.page.url = 'https://www.wikipedia.org/other';
    }
    if (kind === 'inclusion')
      research.inclusions.push({ captureId: source.captureId, contentSha256: 'c'.repeat(64), includedAt: new Date().toISOString() });
    if (kind === 'duplicate') research.captures.push(source);
    expect(() => assertResearchHistory(research)).toThrow();
  });
});
