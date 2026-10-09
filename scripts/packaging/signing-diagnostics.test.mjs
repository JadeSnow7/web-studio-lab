import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { identitySummary, certificateSummary, recognizedTrustCodes, diagnosticTool, toolStatus } from './signing-diagnostics.mjs';

const name = 'Developer ID Application: Synthetic Person (TESTTEAM01)';
const fingerprint = 'A'.repeat(40);
const privateMarker = 'never-emit-private-marker@example.invalid';
function fakeCertificate(subjectCN, issuerOU = 'G2') {
  return {
    toLegacyObject: () => ({
      subject: { CN: subjectCN, O: 'Apple Inc.', UID: privateMarker },
      issuer: { CN: 'Developer ID Certification Authority', O: 'Apple Inc.', OU: issuerOU },
    }),
    fingerprint: fingerprint.match(/../g).join(':'),
    validFrom: 'Oct 8 00:00:00 2026 GMT',
    validTo: 'Sep 17 00:00:00 2031 GMT',
  };
}
test('identity summaries distinguish invalid matches and avoid counting repeated valid rows', () => {
  const text = `Matching identities\n  1) ${fingerprint} "${name}" (CSSMERR_TP_NOT_TRUSTED)\n  2) ${'B'.repeat(40)} "Other ${privateMarker}"\n  2 identities found\nValid identities only\n  1) ${'B'.repeat(40)} "Other ${privateMarker}"\n  1 valid identities found`;
  assert.deepEqual(identitySummary(text, name), {
    count: 2,
    configuredNameMatch: true,
    configuredNameMatchCount: 1,
    recognizedTrustCodes: ['CSSMERR_TP_NOT_TRUSTED'],
  });
  assert.equal(identitySummary(text, name + ' ').configuredNameMatch, false);
  assert.deepEqual(identitySummary('  0 valid identities found', name), {
    count: 0,
    configuredNameMatch: false,
    configuredNameMatchCount: 0,
    recognizedTrustCodes: [],
  });
  assert.doesNotMatch(JSON.stringify(identitySummary(text, name)), /Synthetic|TESTTEAM|AAAA|never-emit/);
});
test('public certificate summaries expose type, issuer class, dates and matching booleans only', () => {
  const summary = certificateSummary(fakeCertificate(name), name, new Set([fingerprint]), Date.parse('2026-10-09'));
  assert.deepEqual(summary, {
    configuredNameMatch: true,
    kind: 'DeveloperIDApplication',
    issuerClass: 'Apple Developer ID G2',
    notBefore: '2026-10-08T00:00:00.000Z',
    notAfter: '2031-09-17T00:00:00.000Z',
    dateValidity: 'current',
    appearsInValidIdentities: true,
  });
  assert.equal(
    certificateSummary(fakeCertificate(name, 'Apple Certification Authority'), name, new Set(), Date.parse('2032-01-01')).dateValidity,
    'expired',
  );
  assert.equal(
    certificateSummary(fakeCertificate(name, 'Apple Certification Authority'), name, new Set()).issuerClass,
    'Apple Developer ID G1',
  );
  assert.equal(certificateSummary(fakeCertificate('Apple Development: ' + privateMarker), name, new Set()).kind, 'AppleDevelopment');
  assert.equal(certificateSummary(fakeCertificate('Apple Distribution: ' + privateMarker), name, new Set()).kind, 'AppleDistribution');
  assert.equal(certificateSummary(fakeCertificate('Developer ID Certification Authority'), name, new Set()).kind, 'DeveloperIDCA');
  assert.equal(certificateSummary(fakeCertificate(name), name, new Set(), Date.parse('2020-01-01')).dateValidity, 'not-yet-valid');
  assert.doesNotMatch(JSON.stringify(summary), /Synthetic|TESTTEAM|AAAA|never-emit/);
});
test('tool failures have bounded execution and emit only allowlisted status codes', () => {
  const result = diagnosticTool('/usr/bin/security', ['synthetic'], undefined, (_tool, _args, options) => {
    assert.equal(options.timeout, 15_000);
    assert.equal(options.killSignal, 'SIGKILL');
    return {
      status: null,
      error: { code: 'ETIMEDOUT', message: privateMarker },
      stdout: privateMarker,
      stderr: `CSSMERR_TP_CERT_EXPIRED errSecAuthFailed ${privateMarker}`,
    };
  });
  assert.deepEqual(toolStatus(result), {
    status: null,
    failed: true,
    timedOut: true,
    recognizedTrustCodes: ['CSSMERR_TP_CERT_EXPIRED', 'errSecAuthFailed'],
  });
  assert.doesNotMatch(JSON.stringify(toolStatus(result)), /never-emit/);
  assert.deepEqual(recognizedTrustCodes('CSSMERR_UNKNOWN errSecArbitrary CSSMERR_TP_NOT_TRUSTED CSSMERR_TP_NOT_TRUSTED'), [
    'CSSMERR_TP_NOT_TRUSTED',
  ]);
  assert.equal(
    toolStatus(
      diagnosticTool('tool', [], undefined, () => {
        throw new Error(privateMarker);
      }),
    ).failed,
    true,
  );
});
test('diagnostic workflow is branch-only, read-only and retains unconditional cleanup', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/signing-diagnostics.yml', import.meta.url), 'utf8');
  assert.match(workflow, /branches: \['codex\/signing-diagnostics-20261009'\]/);
  assert.match(workflow, /github.repository == 'JadeSnow7\/web-studio-lab'/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /package-manager-cache: false/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /ci-signing\.mjs cleanup/);
  assert.doesNotMatch(workflow, /workflow_dispatch|pull_request|tags:|contents: write|upload-artifact|pnpm package/);
});
