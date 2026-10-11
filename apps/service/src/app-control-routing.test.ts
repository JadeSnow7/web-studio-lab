import { emptyReferences } from './reference-test-fixture';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CodexChat } from './codex-chat';
import type { ObservationTurnScope } from '@wsl/protocol';

let chat: CodexChat;
let root: string;
const scope: ObservationTurnScope = { workspaceId: 'space-a', sessionId: 'session-a', runId: 'run-a', sources: [] };
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wsl-app-routing-'));
  vi.stubEnv('WSL_SBX_NAME', 'fixture');
  vi.stubEnv('WSL_SBX_BIN', path.resolve('apps/service/src/fixtures/observation-sbx.mjs'));
  chat = new CodexChat(root, vi.fn());
  await chat.initialize();
  chat.register(scope.sessionId, scope.workspaceId);
});
afterEach(async () => {
  await chat.shutdown();
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const reply = () => JSON.parse(chat.get(scope.sessionId).messages.find((message) => message.role === 'assistant')!.text);

it('routes app.* frames from the guest socket to the control-plane reader with the frozen run scope', async () => {
  const observation = vi.fn();
  const control = vi.fn().mockResolvedValue({ ok: true, tool: 'app.ui.snapshot', data: { documentGeneration: 3 } });
  chat.setObservationReader(observation);
  chat.setAppControlReader(control);
  await chat.send(scope.sessionId, 'app', scope, emptyReferences(scope.sessionId, scope.workspaceId));
  await vi.waitFor(() => expect(chat.get(scope.sessionId).state).toBe('idle'));
  expect(observation).not.toHaveBeenCalled();
  expect(control.mock.calls[0]!.slice(0, 3)).toEqual([scope, 'app.ui.snapshot', { limit: 5 }]);
  expect(reply()).toEqual({ ok: true, tool: 'app.ui.snapshot', data: { documentGeneration: 3 } });
});

it('without a control-plane reader the guest receives a structured no_active_run error, not an observation', async () => {
  const observation = vi.fn();
  chat.setObservationReader(observation);
  await chat.send(scope.sessionId, 'app', scope, emptyReferences(scope.sessionId, scope.workspaceId));
  await vi.waitFor(() => expect(chat.get(scope.sessionId).state).toBe('idle'));
  expect(observation).not.toHaveBeenCalled();
  expect(reply()).toMatchObject({ ok: false, error: { code: 'no_active_run' } });
});
