/* global process, console */
import { X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Only these public error identifiers may leave the process. Never print raw
// output, Error objects, certificate subjects, fingerprints or command argv.
const trustCodes = new Set([
  'CSSMERR_TP_NOT_TRUSTED',
  'CSSMERR_TP_CERT_EXPIRED',
  'CSSMERR_TP_CERT_NOT_VALID_YET',
  'CSSMERR_TP_CERT_REVOKED',
  'CSSMERR_TP_INVALID_CERTIFICATE',
  'CSSMERR_TP_INVALID_ANCHOR_CERT',
  'CSSMERR_TP_VERIFY_ACTION_FAILED',
  'CSSMERR_TP_INVALID_CERT_AUTHORITY',
  'errSecNotTrusted',
  'errSecCertificateExpired',
  'errSecCertificateNotValidYet',
  'errSecCertificateRevoked',
  'errSecItemNotFound',
  'errSecAuthFailed',
  'errSecInteractionNotAllowed',
  'errSecInvalidTrustSettings',
]);
export function recognizedTrustCodes(text) {
  return [...new Set(String(text).match(/\b(?:CSSMERR_[A-Z_]+|errSec[A-Za-z]+)\b/g) ?? [])].filter((code) => trustCodes.has(code));
}
function identityRows(text) {
  return [...String(text).matchAll(/^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"([^"\r\n]*)"([^\r\n]*)/gm)].map((match) => ({
    fingerprint: match[1].toUpperCase(),
    name: match[2],
    codes: recognizedTrustCodes(match[3]),
  }));
}
export function identitySummary(text, expectedName) {
  // Without -v, security repeats valid identities in a second section.
  const matchingSection = String(text).split(/Valid identities only/i)[0];
  const rows = identityRows(matchingSection);
  return {
    count: rows.length,
    configuredNameMatch: rows.some((row) => row.name === expectedName),
    configuredNameMatchCount: rows.filter((row) => row.name === expectedName).length,
    recognizedTrustCodes: recognizedTrustCodes(text),
  };
}
export function certificateSummary(certificate, expectedName, validFingerprints, now = Date.now()) {
  const { subject, issuer } = certificate.toLegacyObject();
  const issuerClass =
    issuer.O === 'Apple Inc.' && issuer.CN === 'Developer ID Certification Authority'
      ? issuer.OU === 'G2'
        ? 'Apple Developer ID G2'
        : issuer.OU === 'Apple Certification Authority'
          ? 'Apple Developer ID G1'
          : 'Apple Developer ID other'
      : issuer.O === 'Apple Inc.'
        ? 'Apple other CA'
        : 'other';
  const before = Date.parse(certificate.validFrom);
  const after = Date.parse(certificate.validTo);
  return {
    configuredNameMatch: subject.CN === expectedName,
    kind:
      typeof subject.CN !== 'string'
        ? 'other'
        : subject.CN.startsWith('Developer ID Application:')
          ? 'DeveloperIDApplication'
          : subject.CN.startsWith('Apple Development:')
            ? 'AppleDevelopment'
            : subject.CN.startsWith('Apple Distribution:')
              ? 'AppleDistribution'
              : subject.CN === 'Developer ID Certification Authority' && subject.O === 'Apple Inc.'
                ? 'DeveloperIDCA'
                : 'other',
    issuerClass,
    notBefore: Number.isFinite(before) ? new Date(before).toISOString() : null,
    notAfter: Number.isFinite(after) ? new Date(after).toISOString() : null,
    dateValidity:
      !Number.isFinite(before) || !Number.isFinite(after)
        ? 'unknown'
        : now < before
          ? 'not-yet-valid'
          : now > after
            ? 'expired'
            : 'current',
    appearsInValidIdentities: validFingerprints.has(certificate.fingerprint.replaceAll(':', '').toUpperCase()),
  };
}
export function diagnosticTool(command, args, input, execute = spawnSync) {
  let result;
  try {
    result = execute(command, args, { encoding: 'utf8', input, timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return { status: null, failed: true, timedOut: false, recognizedTrustCodes: [], stdout: '' };
  }
  return {
    status: Number.isInteger(result.status) ? result.status : null,
    failed: Boolean(result.error || result.status !== 0),
    timedOut: result.error?.code === 'ETIMEDOUT',
    recognizedTrustCodes: recognizedTrustCodes((result.stdout ?? '') + '\n' + (result.stderr ?? '')),
    stdout: result.stdout ?? '',
  };
}
export function toolStatus(result) {
  return { status: result.status, failed: result.failed, timedOut: result.timedOut, recognizedTrustCodes: result.recognizedTrustCodes };
}
function certificates(pem, limit) {
  const blocks = String(pem).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length > limit) throw new Error('Certificate limit exceeded');
  return blocks.map((block) => new X509Certificate(block));
}
export async function collectDiagnostics(env) {
  const expected = path.join(env.RUNNER_TEMP ?? '', 'wsl-release-signing', 'release.keychain-db');
  if (!path.isAbsolute(env.RUNNER_TEMP ?? '') || env.APPLE_KEYCHAIN !== expected || !env.CSC_NAME?.startsWith('Developer ID Application:'))
    throw new Error('Invalid diagnostic configuration');
  let exists = true;
  try {
    await access(expected);
  } catch {
    exists = false;
  }
  const security = (args) => diagnosticTool('/usr/bin/security', args);
  const search = security(['list-keychains', '-d', 'user']);
  const names = [...search.stdout.matchAll(/"([^"\n]+)"/g)].map((match) => match[1]);
  const report = {
    schemaVersion: 1,
    keychain: {
      exists,
      inUserSearchList: names.includes(expected),
      searchList: toolStatus(search),
      settings: toolStatus(security(['show-keychain-info', expected])),
    },
    identities: {},
  };
  const validFingerprints = new Set();
  for (const [scope, suffix] of [
    ['default', []],
    ['explicit', [expected]],
  ]) {
    report.identities[scope] = {};
    for (const [kind, flags] of [
      ['valid', ['-v']],
      ['all', []],
    ]) {
      const result = security(['find-identity', ...flags, '-p', 'codesigning', ...suffix]);
      report.identities[scope][kind] = { ...identitySummary(result.stdout, env.CSC_NAME), ...toolStatus(result) };
      if (scope === 'explicit' && kind === 'valid' && !result.failed)
        for (const row of identityRows(result.stdout)) validFingerprints.add(row.fingerprint);
    }
  }
  const imported = security(['find-certificate', '-a', '-p', expected]);
  const leaves = certificates(imported.stdout, 32);
  report.importedCertificates = { ...toolStatus(imported), count: leaves.length, certificates: [] };
  const directory = await mkdtemp(path.join(env.RUNNER_TEMP, 'wsl-public-cert-diagnostics-'));
  let verifiedLeaves = 0;
  try {
    for (const [index, certificate] of leaves.entries()) {
      const metadata = certificateSummary(certificate, env.CSC_NAME, validFingerprints);
      if (metadata.configuredNameMatch) {
        if (verifiedLeaves >= 4) {
          metadata.offlineTrust = { skipped: 'matching-certificate-limit' };
          report.importedCertificates.certificates.push(metadata);
          continue;
        }
        verifiedLeaves++;
        // This is public certificate DER only. Offline policy forbids issuer
        // downloads and live revocation requests; no trust state is changed.
        const file = path.join(directory, `certificate-${index}.cer`);
        await writeFile(file, certificate.raw, { mode: 0o600 });
        metadata.offlineTrust = {};
        for (const [scope, suffix] of [
          ['default', []],
          ['explicit', ['-k', expected]],
        ])
          metadata.offlineTrust[scope] = toolStatus(
            security(['verify-cert', '-p', 'codeSign', '-c', file, '-L', '-R', 'offline', '-q', ...suffix]),
          );
      }
      report.importedCertificates.certificates.push(metadata);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const available = security(['find-certificate', '-a', '-p', '-c', 'Developer ID Certification Authority']);
  const counts = { G1: 0, G2: 0, other: 0 };
  for (const certificate of certificates(available.stdout, 2048)) {
    const { subject } = certificate.toLegacyObject();
    if (subject.O === 'Apple Inc.' && subject.CN === 'Developer ID Certification Authority')
      counts[subject.OU === 'G2' ? 'G2' : subject.OU === 'Apple Certification Authority' ? 'G1' : 'other']++;
  }
  report.defaultDeveloperIdIntermediates = { ...toolStatus(available), counts };
  return report;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'darwin') throw new Error('Runner required');
    console.log(JSON.stringify(await collectDiagnostics(process.env), null, 2));
  } catch {
    console.error('Signing diagnostics could not complete; raw tool output and error details suppressed.');
    process.exitCode = 1;
  }
}
