import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkDocs, requiredDocuments } from './check-docs.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'wsl-docs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const document of requiredDocuments) {
    mkdirSync(path.dirname(path.join(root, document)), { recursive: true });
    writeFileSync(path.join(root, document), '# Fixture\n');
  }
  return root;
}

test('requires the revised current plan rather than silently skipping an absent file', (t) => {
  const root = fixture(t);
  assert.deepEqual(checkDocs(root).errors, []);
  rmSync(path.join(root, 'docs/plans/2026-10-16-post-review-update-plan.md'));
  assert.ok(checkDocs(root).errors.some((error) => error.includes('2026-10-16-post-review-update-plan.md: required file is missing')));
});

test('new ADRs join the normative inventory without editing the checker', (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, 'docs/architecture/adr/0003-future.md'), '# Future  \n[missing](../missing.md)\n');
  const result = checkDocs(root);
  assert.ok(result.documents.includes('docs/architecture/adr/0003-future.md'));
  assert.ok(result.errors.some((error) => error.includes('0003-future.md:1: trailing whitespace')));
  assert.ok(result.errors.some((error) => error.includes('local link target is missing')));
});

test('retains link checks without interpreting code examples as prose links', (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, 'README.md'), '[valid](AGENTS.md)\n`[example](absent.md)`\n```md\n[example](absent.md)\n```\n');
  assert.deepEqual(checkDocs(root).errors, []);
});
