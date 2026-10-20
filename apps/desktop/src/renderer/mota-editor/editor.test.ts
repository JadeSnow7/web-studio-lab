import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MotaEditorBridge, MotaEditorProjection, MotaEditorSaveInput } from '@wsl/protocol';

type Operation = MotaEditorProjection['operations'][number];
// Only the DOM properties/events used by this entrypoint; no browser or native guard is simulated here.
class Control extends EventTarget {
  value = '';
  disabled = false;
  hidden = false;
  textContent = '';
  dataset: Record<string, string> = {};
}
async function editor() {
  vi.resetModules();
  const controls = new Map(
    [
      'content',
      'file',
      'save',
      'read',
      'state',
      'operation-state',
      'conflict',
      'before',
      'current',
      'recovery',
      'status',
      'close',
      'use-current',
    ].map((id) => [id, new Control()]),
  );
  const control = (id: string) => controls.get(id)!;
  let projection: MotaEditorProjection = { sessionIndex: 1, state: 'active', theme: 'light', error: null, operations: [] };
  let receive!: (value: MotaEditorProjection) => void;
  let reply!: (value: Operation) => void;
  let stored = '';
  const save = vi.fn<MotaEditorBridge['save']>(() => new Promise((resolve) => (reply = resolve)));
  const read = vi.fn<MotaEditorBridge['read']>(async () => ({
    sessionIndex: projection.sessionIndex!,
    content: 'baseline',
    contentHash: 'a'.repeat(64),
    contentLength: 8,
  }));
  vi.stubGlobal(
    'document',
    Object.assign(new EventTarget(), {
      getElementById: control,
      documentElement: { dataset: {} },
    }),
  );
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn() }));
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: (_key: string, value: string) => (stored = value) });
  vi.stubGlobal('window', {
    motaEditor: {
      read,
      save,
      close: vi.fn(),
      status: vi.fn(async () => projection),
      onState: (listener: typeof receive) => {
        receive = listener;
        return () => {};
      },
    },
  });
  await import('./editor');
  await vi.waitFor(() => expect(control('state').textContent).toBe('已连接，可读取文件。'));
  const emit = (next: Partial<MotaEditorProjection>) => {
    projection = { ...projection, ...next };
    receive(projection);
  };
  const input = (text: string) => {
    control('content').value = text;
    control('content').dispatchEvent(new Event('input'));
  };
  const start = async () => {
    control('read').dispatchEvent(new Event('click'));
    await vi.waitFor(() => expect(control('state').textContent).toBe('已读取当前版本。'));
    input('submitted');
    expect(control('save').disabled).toBe(false);
    control('save').dispatchEvent(new Event('click'));
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    return save.mock.calls[0]![0];
  };
  return {
    control,
    emit,
    input,
    start,
    save,
    read,
    reply: (value: Operation) => reply(value),
    stored: () => JSON.parse(stored) as Record<string, { baseline: string; original: string; text: string }>,
  };
}
function committed(request: MotaEditorSaveInput): Operation {
  return {
    sessionIndex: request.sessionIndex,
    durabilityIssue: null,
    operation: {
      requestId: request.requestId,
      status: 'committed',
      error: null,
      receipt: {
        editorSessionId: 'original-session',
        requestId: request.requestId,
        file: request.file,
        expectedHash: request.expectedHash,
        contentLength: 9,
        contentHash: 'b'.repeat(64),
        afterHash: 'b'.repeat(64),
        durabilityError: null,
      },
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe('trusted editor original save feedback', () => {
  it('keeps the normal save status and both committed fact and revoked permission after later projections', async () => {
    const f = await editor();
    const request = await f.start();
    const result = committed(request);
    f.reply(result);
    await vi.waitFor(() => expect(f.control('state').textContent).toBe('已保存到副本。可刷新游戏查看。'));
    f.emit({ state: 'revoked', operations: [result] });
    f.emit({ theme: 'dark' });
    expect(f.control('state').textContent).toContain('授权已撤销');
    expect(f.control('operation-state').textContent).toBe('本次保存：已保存到副本。可刷新游戏查看。');
    expect(f.control('operation-state').hidden).toBe(false);
    expect(f.control('operation-state').dataset['requestId']).toBe(request.requestId);
    expect(f.control('save').disabled).toBe(true);
    expect(f.save).toHaveBeenCalledTimes(1);
  });

  it('accepts a late original commit after revocation without restoring its read capability', async () => {
    const f = await editor();
    const request = await f.start();
    const result = committed(request);
    f.emit({ state: 'revoked', operations: [result] });
    f.reply(result);
    await vi.waitFor(() => expect(f.control('read').disabled).toBe(false));
    f.emit({ state: 'revoked' });
    expect(f.control('state').textContent).toContain('授权已撤销');
    expect(f.control('operation-state').textContent).toContain('已保存到副本');
    expect(f.control('content').value).toBe('submitted');
    expect(f.control('save').disabled).toBe(true);
    expect(f.save).toHaveBeenCalledTimes(1);
  });

  it.each([
    [false, 'new draft'],
    [true, 'new draft'],
    [false, 'baseline'],
  ] as const)('does not rebase a changed draft on a late commit (new owner: %s, text: %s)', async (newOwner, newerText) => {
    const f = await editor();
    const request = await f.start();
    if (newOwner) f.emit({ sessionIndex: 2, state: 'active' });
    f.input(newerText);
    const unrelated = { ...committed(request), sessionIndex: 2 };
    f.emit({ operations: newOwner ? [unrelated] : [] });
    expect(f.control('operation-state').hidden).toBe(true);
    f.reply(committed(request));
    await vi.waitFor(() => expect(f.control('read').disabled).toBe(false));
    expect(f.control('content').value).toBe(newerText);
    expect(f.control('state').textContent).toBe('有未保存草稿，请先读取当前版本核对。');
    expect(f.stored()['project/floors/MT1.js']).toMatchObject({ text: newerText, original: 'baseline', baseline: 'a'.repeat(64) });
    expect(f.control('save').disabled).toBe(true);
    expect(f.control('operation-state').textContent).toContain(newOwner ? '原会话保存：已保存到副本' : '本次保存：已保存到副本');
    expect(f.control('operation-state').dataset['sessionIndex']).toBe('1');
    expect(f.save).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('describes the selected file after another file commits (existing draft: %s)', async (existingDraft) => {
    const f = await editor();
    const select = (file: string) => {
      f.control('file').value = file;
      f.control('file').dispatchEvent(new Event('change'));
    };
    if (existingDraft) {
      select('_server/config.json');
      f.control('read').dispatchEvent(new Event('click'));
      await vi.waitFor(() => expect(f.control('state').textContent).toBe('已读取当前版本。'));
      f.input('config draft');
      select('project/floors/MT1.js');
    }
    const request = await f.start();
    select('_server/config.json');
    f.reply(committed(request));
    await vi.waitFor(() => expect(f.control('read').disabled).toBe(false));
    expect(f.control('state').textContent).toBe(existingDraft ? '有未保存草稿，请先读取当前版本核对。' : '已连接，可读取文件。');
    expect(f.control('content').value).toBe(existingDraft ? 'config draft' : '');
    expect(f.control('save').disabled).toBe(!existingDraft);
    expect(f.control('operation-state').textContent).toBe('本次保存：已保存到副本。可刷新游戏查看。');
    expect(f.control('operation-state').dataset['requestId']).toBe(request.requestId);
    expect(f.stored()['project/floors/MT1.js']).toMatchObject({ text: 'submitted', original: 'submitted', baseline: 'b'.repeat(64) });
    expect(f.save).toHaveBeenCalledTimes(1);
  });

  it.each(['durabilityIssue', 'durabilityError'] as const)(
    'preserves committed and %s through revocation and owner replacement',
    async (issue) => {
      const f = await editor();
      const request = await f.start();
      const result = committed(request);
      if (issue === 'durabilityIssue') result.durabilityIssue = 'record persist failed';
      else result.operation.receipt!.durabilityError = 'directory sync failed';
      f.emit({ state: 'revoked', operations: [result] });
      f.reply(committed(request));
      await vi.waitFor(() => expect(f.control('read').disabled).toBe(false));
      f.emit({ sessionIndex: 2, state: 'active', operations: [] });
      expect(f.control('operation-state').textContent).toBe('原会话保存：已保存到副本，但持久化确认有异常，请核对状态。');
      expect(f.control('operation-state').dataset['kind']).toBe('unknown');
      expect(f.control('save').disabled).toBe(true);
      expect(f.save).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps an unknown original result visible and blocks replay after owner replacement', async () => {
    const f = await editor();
    const request = await f.start();
    const result: Operation = {
      sessionIndex: 1,
      durabilityIssue: null,
      operation: {
        requestId: request.requestId,
        status: 'unknown',
        receipt: null,
        error: 'reply lost',
      },
    };
    f.reply(result);
    await vi.waitFor(() => expect(f.control('state').textContent).toContain('不能重复提交'));
    f.emit({ sessionIndex: 2, state: 'active', operations: [] });
    expect(f.control('operation-state').textContent).toBe('原会话保存：保存结果待核对，不能重复提交。');
    expect(f.control('operation-state').dataset['kind']).toBe('unknown');
    expect(f.control('save').disabled).toBe(true);
    expect(f.control('read').disabled).toBe(true);
    expect(f.save).toHaveBeenCalledTimes(1);
  });

  it('does not replace confirmed commit facts with an earlier in-flight projection', async () => {
    const f = await editor();
    const request = await f.start();
    f.reply(committed(request));
    await vi.waitFor(() => expect(f.control('read').disabled).toBe(false));
    f.emit({
      state: 'revoked',
      operations: [
        {
          sessionIndex: 1,
          durabilityIssue: null,
          operation: {
            requestId: request.requestId,
            status: 'staged',
            receipt: null,
            error: null,
          },
        },
      ],
    });
    expect(f.control('state').textContent).toContain('授权已撤销');
    expect(f.control('operation-state').textContent).toBe('本次保存：已保存到副本。可刷新游戏查看。');
    expect(f.control('save').disabled).toBe(true);
  });
});
