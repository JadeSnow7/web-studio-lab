import path from 'node:path';
import { expect, it } from 'vitest';
import { CodexChat } from './codex-chat';
import { REGISTERED_HARNESSES } from './harness/registry';
import { SbxConnection } from './sbx';

it('App actions fixture reports ACP unavailable and confirms probe cleanup before shutdown', async () => {
  const connection = new SbxConnection({
    sbxBinary: path.resolve('e2e/fixtures/sbx-app-actions.mjs'),
    sandbox: 'app-actions-fixture',
  });
  const chat = new CodexChat('.', () => undefined, connection, REGISTERED_HARNESSES);
  try {
    const status = await chat.initialize();
    expect(status.available).toBe(true);
    expect(status.harnesses.map(({ descriptor, available }) => [descriptor.harnessId, available])).toEqual([
      ['codex', true],
      ['claude-code', false],
    ]);
    expect(connection.getCleanupPending()).toBe(false);
  } finally {
    await chat.shutdown();
  }
});

it.each(['codex', 'claude-code'])('App actions fixture confirms cleanup after the %s Profile self-check', async (harnessId) => {
  const connection = new SbxConnection({
    sbxBinary: path.resolve('e2e/fixtures/sbx-app-actions.mjs'),
    sandbox: 'app-actions-profile-fixture',
  });
  const chat = new CodexChat('.', () => undefined, connection, REGISTERED_HARNESSES);
  try {
    await chat.initialize();
    const receipt = await chat.checkProfileReceipt(harnessId, null);
    expect(receipt).toMatchObject({ type: 'profile-check', ok: true, cleanupConfirmed: true });
    if (harnessId === 'claude-code') expect(receipt).toMatchObject({ result: { cliVersion: null, login: 'undetermined' } });
    expect(connection.getCleanupPending()).toBe(false);
  } finally {
    await chat.shutdown();
  }
});
