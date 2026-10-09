/* global Buffer, Response */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { URL } from 'node:url';
import { digest } from './payload-lib.mjs';
import { signingTool, setupSigning, cleanupSigning, validateSigningSecrets } from './ci-signing.mjs';
import { validateReleaseTag, prepareReleaseAssets, verifyReleaseAssets, publishRelease } from './release-ci.mjs';
import { verifySignedRuntime } from './signed-runtime.mjs';

async function temporary(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wsl-ci-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function assetsFixture(t, version = '0.1.0') {
  const dir = await temporary(t);
  const release = path.join(dir, 'release');
  await mkdir(path.join(release, 'artifacts'), { recursive: true });
  const lines = [];
  for (const name of ['App.dmg', 'App.zip']) {
    await writeFile(path.join(release, name), name);
    lines.push(`${digest(name)}  ${name}`);
  }
  const commit = 'a'.repeat(40);
  const manifest = {
    schemaVersion: 1,
    version,
    gitCommit: commit,
    dirtyPaths: [],
    notarization: { status: 'Accepted' },
    validation: ['codesign', 'spctl', 'stapler'],
    artifacts: lines,
  };
  await writeFile(path.join(release, 'artifacts/release-manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(release, 'artifacts/SHA256SUMS'), lines.join('\n') + '\n');
  for (const name of [
    'INSTALLATION.zh-CN.md',
    'ACCEPTANCE.md',
    'dependencies.json',
    'dependency-sources.json',
    'THIRD-PARTY-NOTICES.md',
    'LICENSE',
  ])
    await writeFile(path.join(release, 'artifacts', name), name);
  const directory = path.join(dir, 'assets');
  const tag = 'v' + version;
  await prepareReleaseAssets(release, directory, tag, commit);
  return { directory, release, tag, commit, repository: 'owner/repo', token: 'fixture-token' };
}
function githubServer(seed, { paginated = false, moved = false } = {}) {
  let release = seed;
  let tagReads = 0;
  const bytes = new Map();
  const calls = [];
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
  const request = async (url, options = {}) => {
    url = String(url);
    const method = options.method || 'GET';
    calls.push({ url, method });
    if (url.includes('/git/ref/tags/'))
      return json({ object: { type: 'commit', sha: moved && ++tagReads > 1 ? 'b'.repeat(40) : 'a'.repeat(40) } });
    if (url.includes('/releases?')) {
      if (paginated && new URL(url).searchParams.get('page') === '1')
        return json(Array.from({ length: 100 }, (_, index) => ({ tag_name: 'old-' + index })));
      return json(release ? [release] : []);
    }
    if (method === 'POST' && url.endsWith('/releases')) {
      release = {
        ...JSON.parse(options.body),
        id: 99,
        assets: [],
        upload_url: 'https://uploads.github.com/repos/owner/repo/releases/99/assets{?name,label}',
      };
      return json(release, 201);
    }
    if (method === 'POST' && url.startsWith('https://uploads.github.com/')) {
      const name = new URL(url).searchParams.get('name');
      const chunks = [];
      for await (const chunk of options.body) chunks.push(chunk);
      const content = Buffer.concat(chunks);
      const asset = { name, id: release.assets.length + 1, size: content.length, url: 'https://api.github.com/assets/' + name };
      bytes.set(asset.url, content);
      release.assets.push(asset);
      return json(asset, 201);
    }
    if (url.startsWith('https://api.github.com/assets/')) return new Response(bytes.get(url));
    if (url.endsWith('/releases/99') && method === 'GET') return json(release);
    if (url.endsWith('/releases/99') && method === 'PATCH') {
      Object.assign(release, JSON.parse(options.body));
      return json(release);
    }
    throw new Error('Unexpected fixture request: ' + method + ' ' + url);
  };
  return { request, calls, bytes, current: () => release };
}

test('CI rejects mismatched or injected tags and corrupted asset bytes', async (t) => {
  assert.equal(validateReleaseTag('v0.1.0', '0.1.0'), 'v0.1.0');
  assert.throws(() => validateReleaseTag('v0.1.0\noutput=x', '0.1.0'), /Release tag/);
  assert.throws(() => validateReleaseTag('v0.2.0', '0.1.0'), /Release tag/);
  const fixture = await assetsFixture(t);
  await writeFile(path.join(fixture.directory, 'App.dmg'), 'corrupt');
  let calls = 0;
  await assert.rejects(
    publishRelease(fixture, async () => {
      calls++;
    }),
    /inventory\/hash mismatch/,
  );
  assert.equal(calls, 0);
});
test('CI publishes only after uploading and verifying every asset, including prereleases', async (t) => {
  const fixture = await assetsFixture(t, '0.1.0-rc.1');
  const server = githubServer();
  await publishRelease(fixture, server.request);
  assert.equal(server.current().draft, false);
  assert.equal(server.current().prerelease, true);
  const count = (await verifyReleaseAssets(fixture.directory, fixture.tag, fixture.commit)).length;
  assert.equal(server.current().assets.length, count);
  assert.equal(server.calls.filter((call) => call.method === 'PATCH').length, 1);
  assert.equal(server.calls.at(-1).method, 'PATCH');
});
test('CI finds a matching draft on later pages and retries without replacing assets', async (t) => {
  const fixture = await assetsFixture(t);
  const files = await verifyReleaseAssets(fixture.directory, fixture.tag, fixture.commit);
  const seed = {
    id: 99,
    tag_name: fixture.tag,
    draft: true,
    body: `<!-- wsl-release:${fixture.commit}:${digest(JSON.stringify(files))} -->`,
    assets: files.map((file) => ({ name: file.name, url: 'https://api.github.com/assets/' + file.name })),
    upload_url: 'https://uploads.github.com/repos/owner/repo/releases/99/assets{?name}',
  };
  const server = githubServer(seed, { paginated: true });
  for (const file of files)
    server.bytes.set('https://api.github.com/assets/' + file.name, await readFile(path.join(fixture.directory, file.name)));
  await publishRelease(fixture, server.request);
  assert.equal(
    server.calls.some((call) => call.url.includes('page=2')),
    true,
  );
  assert.equal(server.calls.filter((call) => call.method === 'POST').length, 0);
  assert.equal(server.current().draft, false);
});
test('CI refuses published releases and refuses publication after a remote tag moves', async (t) => {
  const fixture = await assetsFixture(t);
  const existing = githubServer({ id: 99, tag_name: fixture.tag, draft: false });
  await assert.rejects(publishRelease(fixture, existing.request), /Published releases are immutable/);
  assert.equal(
    existing.calls.some((call) => call.method !== 'GET'),
    false,
  );
  const moved = githubServer(undefined, { moved: true });
  await assert.rejects(publishRelease(fixture, moved.request), /Remote release tag moved/);
  assert.equal(moved.current().draft, true);
  assert.equal(
    moved.calls.some((call) => call.method === 'PATCH'),
    false,
  );
});
test('CI rejects another draft asset set and failed lookup does not create a release', async (t) => {
  const fixture = await assetsFixture(t);
  const other = githubServer({ id: 99, tag_name: fixture.tag, draft: true, body: 'another build' });
  await assert.rejects(publishRelease(fixture, other.request), /different commit or asset set/);
  let mutations = 0;
  await assert.rejects(
    publishRelease(fixture, async (_url, options) => {
      if (options?.method && options.method !== 'GET') mutations++;
      return new Response('', { status: 503 });
    }),
    /HTTP 503/,
  );
  assert.equal(mutations, 0);
});
test('CI imports only supplied certificate data and cleans up its own temporary keychain', async (t) => {
  const dir = await temporary(t);
  const env = {
    RUNNER_TEMP: dir,
    GITHUB_ENV: path.join(dir, 'github-env'),
    MACOS_CERTIFICATE_P12_BASE64: Buffer.from('fixture-certificate').toString('base64'),
    MACOS_CERTIFICATE_PASSWORD: 'fixture-cert-password',
    MACOS_SIGNING_IDENTITY: 'Developer ID Application: Team (6429YPLDYU)',
    APPLE_ID: 'fixture@example.invalid',
    APPLE_APP_SPECIFIC_PASSWORD: 'fixture-notary-password',
    APPLE_TEAM_ID: '6429YPLDYU',
  };
  const calls = [];
  const run = (command, args) => {
    calls.push({ command, args });
    if (args[0] === 'list-keychains' && args.length === 3) return '"/runner/login.keychain-db"';
    return '';
  };
  // The fake tool writes the keychain synchronously to match the synchronous real command.
  const { writeFileSync } = await import('node:fs');
  const syncRun = (command, args) =>
    args[0] === 'create-keychain'
      ? (calls.push({ command, args }), writeFileSync(args.at(-1), 'fixture-keychain'), '')
      : run(command, args);
  await setupSigning(env, syncRun);
  const exported = await readFile(env.GITHUB_ENV, 'utf8');
  assert.equal(exported.includes('fixture-cert-password'), false);
  assert.equal(exported.includes('fixture-notary-password'), false);
  assert.equal(
    calls.some((call) => call.args.includes('export')),
    false,
  );
  await cleanupSigning(env, syncRun);
  await assert.rejects(access(path.join(dir, 'wsl-release-signing')), /ENOENT/);
  assert.deepEqual(calls.findLast((call) => call.args[0] === 'list-keychains').args, [
    'list-keychains',
    '-d',
    'user',
    '-s',
    '/runner/login.keychain-db',
  ]);
  assert.throws(() => validateSigningSecrets({ ...env, MACOS_SIGNING_IDENTITY: 'Apple Development: Team' }), /Developer ID Application/);
});
test('CI tool failures suppress passwords from command error details', () => {
  assert.throws(
    () =>
      signingTool('/usr/bin/security', ['import', 'fixture', '-P', 'SECRET'], () => ({
        status: 1,
        error: new Error('command --password SECRET'),
        stderr: 'SECRET',
      })),
    (error) => !String(error.stack).includes('SECRET') && error.message.includes('security'),
  );
});
test('signed runtime probes disable pyc writes and fail if the probe damages the seal', () => {
  const calls = [];
  verifySignedRuntime('/Signed.app', (command, args) => {
    calls.push({ command, args });
  });
  assert.deepEqual(
    calls.map((call) => path.basename(call.command)),
    ['codesign', 'python3', 'codesign'],
  );
  assert.deepEqual(calls[1].args.slice(0, 2), ['-I', '-B']);
  let signatures = 0;
  assert.throws(
    () =>
      verifySignedRuntime('/Signed.app', (command) => {
        if (command.endsWith('codesign') && ++signatures === 2) throw new Error('seal changed');
      }),
    /seal changed/,
  );
});
