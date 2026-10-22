import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import helper from './guest-helper.py?raw';
import resourceMcp from './resource_mcp.py?raw';
import type { GuestFrame } from './sbx';
import type { HarnessEvent } from './harness/types';
import { AcpTurn } from './harness/acp/turn';
import { emptyReferences } from './reference-test-fixture';

// W3b：真实 guest helper 在本机 Linux 上以 relay 模式转发 stdin，驱动确定性的假 ACP Agent。不经过 sbx，不调用模型。
const fakeAgent = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
const marker = '\ntry:\n    start = read_start()';
const armed = helper.replace('RESOURCE_MCP_BASE64 = ""', `RESOURCE_MCP_BASE64 = "${Buffer.from(resourceMcp).toString('base64')}"`);
const runnable = `${armed.slice(0, armed.lastIndexOf(marker))}\nCWD = sys.argv[1]\ntry:\n    main(read_start())\nexcept BaseException as error:\n    emit("error", error=str(error))\n`;

async function relay(
  start: Record<string, unknown>,
  drive: (send: (frame: unknown) => void, frames: GuestFrame[], next: () => Promise<void>) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'wsl-relay-'));
  const child = spawn('python3', ['-u', '-c', runnable, root], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const frames: GuestFrame[] = [];
  let wake: (() => void) | null = null;
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.startsWith('WSL_GUEST_FRAME:')) return;
    frames.push(JSON.parse(line.slice('WSL_GUEST_FRAME:'.length)) as GuestFrame);
    wake?.();
  });
  const done = new Promise<number | null>((resolve) => child.once('close', resolve));
  const send = (frame: unknown) => child.stdin.write(JSON.stringify(frame) + '\n');
  const next = () => new Promise<void>((resolve) => (wake = resolve));
  send(start);
  try {
    await drive(send, frames, next);
    child.stdin.end();
    expect(await done, stderr).toBe(0);
    return frames;
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== 'linux')('guest helper 的 stdin relay（W3b）', () => {
  it('relay 模式下一轮 ACP 往返完整，input-end 后 Agent 自行退出并确认清理', async () => {
    const events: HarnessEvent[] = [];
    const frames = await relay(
      { type: 'start', mode: 'codex', argv: [process.execPath, fakeAgent, 'reply'], stdin: 'relay' },
      async (send, frames) => {
        let cursor = 0;
        let buffer = '';
        const turn = new AcpTurn(
          (line) => send({ type: 'input', data: line }),
          (event) => events.push(event),
          {
            cwd: '/w',
            mcpServers: [],
            sessionRef: null,
            prompt: '你好',
            signal: new AbortController().signal,
          },
        );
        const pump = setInterval(() => {
          for (; cursor < frames.length; cursor++) {
            const frame = frames[cursor]!;
            if (frame.type !== 'output' || frame.stream !== 'stdout') continue;
            buffer += frame.data;
            while (buffer.includes('\n')) {
              const index = buffer.indexOf('\n');
              turn.receive(buffer.slice(0, index));
              buffer = buffer.slice(index + 1);
            }
          }
        }, 5);
        try {
          expect((await turn.run()).stopReason).toBe('end_turn');
        } finally {
          clearInterval(pump);
        }
        send({ type: 'input-end' });
        await expect.poll(() => frames.some((frame) => frame.type === 'cleanup'), { timeout: 5000 }).toBe(true);
      },
    );
    expect(events.at(-1)).toEqual({ type: 'turn_completed' });
    expect(events).toContainEqual({ type: 'message', id: 'm1', text: '你好，世界' });
    expect(frames.find((frame) => frame.type === 'exit')).toEqual({ type: 'exit', exitCode: 0 });
    expect(frames.at(-1)).toEqual({ type: 'cleanup', ok: true });
  });

  it('acp-stdio 先发出带绝对路径的 MCP 启动帧，再启动 Agent', async () => {
    const frames = await relay(
      {
        type: 'start',
        mode: 'codex',
        argv: [process.execPath, fakeAgent, 'reply'],
        stdin: 'relay',
        mcp: 'acp-stdio',
        resourceBundle: {
          ...emptyReferences('conv-personal-default'),
          conversationId: 'conv-personal-default',
          generation: 'g',
          turnId: 't',
        },
      },
      async (send, frames) => {
        await expect.poll(() => frames.some((frame) => frame.type === 'ready'), { timeout: 5000 }).toBe(true);
        send({ type: 'input-end' });
        await expect.poll(() => frames.some((frame) => frame.type === 'cleanup'), { timeout: 5000 }).toBe(true);
      },
    );
    const mcp = frames.findIndex((frame) => frame.type === 'mcp-server');
    const ready = frames.findIndex((frame) => frame.type === 'ready');
    expect(mcp).toBeGreaterThanOrEqual(0);
    expect(mcp).toBeLessThan(ready);
    const server = frames[mcp] as Extract<GuestFrame, { type: 'mcp-server' }>;
    expect(server.command.startsWith('/')).toBe(true);
    expect(server.args.slice(0, 3)).toEqual(['-I', '-u', '-c']);
    expect(frames.at(-1)).toEqual({ type: 'cleanup', ok: true });
  });

  it.each([
    [{ stdin: 'pipe' }, 'invalid stdin mode'],
    [{ stdin: 'relay', prompt: 'x' }, 'invalid stdin mode'],
  ])('非法 stdin 声明 %j 在预检阶段拒绝', async (extra, message) => {
    const frames = await relay(
      { type: 'start', mode: 'codex', argv: [process.execPath, fakeAgent, 'reply'], ...extra },
      async (_send, frames) => {
        await expect.poll(() => frames.some((frame) => frame.type === 'error'), { timeout: 5000 }).toBe(true);
      },
    );
    expect(frames).toContainEqual({ type: 'error', error: message });
    expect(frames.some((frame) => frame.type === 'ready')).toBe(false);
  });

  it('非 relay 进程拒绝 input-end 控制帧', async () => {
    const frames = await relay({ type: 'start', mode: 'codex', argv: ['sleep', '5'] }, async (send, frames) => {
      await expect.poll(() => frames.some((frame) => frame.type === 'ready'), { timeout: 5000 }).toBe(true);
      send({ type: 'input-end' });
      await expect.poll(() => frames.some((frame) => frame.type === 'cleanup'), { timeout: 8000 }).toBe(true);
    });
    expect(frames).toContainEqual({ type: 'error', error: 'invalid control frame' });
  });
});
