import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  GUEST_BROWSER_SANDBOX,
  GUEST_BROWSER_URL,
  GuestBrowserRequestSchema,
  GuestBrowserResultSchema,
  MAX_GUEST_BROWSER_FRAME_BYTES,
  type GuestBrowserRequest,
  type GuestBrowserResult,
  type GuestBrowserSuccess,
} from '@wsl/protocol';
import { z } from 'zod';
import guestSource from './guest-browser.cjs?raw';
import type { ResourceStore } from './resource-store';

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export class GuestBrowserError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly cleanupConfirmed: boolean,
  ) {
    super(message);
  }
}

/** 仅解释来自固定 guest harness 的有界 JSON，不接受页面回传命令或路径。 */
export function validateGuestCapture(input: unknown, request: GuestBrowserRequest): GuestBrowserResult {
  GuestBrowserRequestSchema.parse(request);
  const result = GuestBrowserResultSchema.parse(input);
  if (!result.cleanup.browserClosed) throw new GuestBrowserError('CLEANUP_UNKNOWN', 'guest 浏览器清理未确认', false);
  if (!result.ok) return result;
  const { snapshot, screenshot, evidence } = result;
  if (
    snapshot.captureId !== request.captureId ||
    snapshot.requestedUrl !== request.url ||
    snapshot.url !== request.url ||
    snapshot.page.sandboxName !== request.sandboxName ||
    evidence.launch.browserPid !== evidence.sandbox.browser.pid ||
    sha(snapshot.text) !== snapshot.contentSha256
  )
    throw new GuestBrowserError('IDENTITY_MISMATCH', 'guest 采集身份或正文摘要不一致', true);
  const png = Buffer.from(screenshot.base64, 'base64');
  if (
    png.toString('base64') !== screenshot.base64 ||
    png.length !== screenshot.bytes ||
    sha(png) !== screenshot.sha256 ||
    screenshot.sha256 !== snapshot.screenshotSha256 ||
    png.length < 33 ||
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    png.toString('ascii', 12, 16) !== 'IHDR' ||
    png.readUInt32BE(16) !== 1280 ||
    png.readUInt32BE(20) !== 800
  )
    throw new GuestBrowserError('SCREENSHOT_MISMATCH', '截图格式、大小或摘要不一致', true);
  return result;
}

async function assertRunningMountlessSandbox(binary: string, startStoppedSandbox: boolean): Promise<void> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(binary, ['inspect', '--json', GUEST_BROWSER_SANDBOX], { stdio: ['ignore', 'pipe', 'ignore'] });
    let bytes = 0;
    const chunks: Buffer[] = [];
    let invalid = false;
    const timer = setTimeout(() => {
      invalid = true;
      child.kill('SIGKILL');
    }, 20000);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 128 * 1024) {
        invalid = true;
        child.kill('SIGKILL');
      } else chunks.push(chunk);
    });
    child.once('error', () => {
      clearTimeout(timer);
      reject(new GuestBrowserError('SANDBOX_INSPECT', '无法检查既有 sandbox', true));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (invalid || code !== 0) reject(new GuestBrowserError('SANDBOX_INSPECT', '无法检查既有 sandbox', true));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
  assertGuestSandboxIdentity(JSON.parse(output), startStoppedSandbox);
}

export function assertGuestSandboxIdentity(input: unknown, startStoppedSandbox = false): void {
  const target = z
    .object({
      name: z.literal(GUEST_BROWSER_SANDBOX),
      agent: z.literal('codex'),
      state: z.enum(['running', 'stopped']),
      runtime_mounts: z.array(z.unknown()).length(0),
    })
    .parse(input);
  if (target.state === 'stopped' && !startStoppedSandbox)
    throw new GuestBrowserError('SANDBOX_STOPPED', 'sandbox 已停止；须明确授权启动', true);
}

/** 不安装、不改 ACL、不启动模型；默认拒绝已停止的 sandbox；启动必须由可信调用者显式确认。 */
export async function captureGuestPage(
  binary: string,
  captureId = randomUUID(),
  options: { startStoppedSandbox: boolean } = { startStoppedSandbox: false },
): Promise<GuestBrowserResult> {
  if (!path.isAbsolute(binary)) throw new Error('sbx 必须使用已核验的绝对路径');
  await assertRunningMountlessSandbox(binary, options.startStoppedSandbox === true);
  const request = GuestBrowserRequestSchema.parse({
    operation: 'capture',
    url: GUEST_BROWSER_URL,
    sandboxName: GUEST_BROWSER_SANDBOX,
    captureId,
  });
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['exec', '-i', '-w', '/home/agent/workspace', GUEST_BROWSER_SANDBOX, 'node', '-e', guestSource], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let bytes = 0;
    let failure: GuestBrowserError | null = null;
    const chunks: Buffer[] = [];
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = (code: string, message: string) => {
      if (failure) return;
      failure = new GuestBrowserError(code, message, false);
      // EOF 请求 guest finally 关闭浏览器；只结束本次本地传输，不以此声称远端已清理。
      child.stdin.end();
      killTimer = setTimeout(() => child.kill('SIGKILL'), 8000);
    };
    const timer = setTimeout(() => cancel('CAPTURE_TIMEOUT', 'guest 采集超时，等待清理'), 70000);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_GUEST_BROWSER_FRAME_BYTES) cancel('FRAME_TOO_LARGE', 'guest 返回超过大小限制');
      else {
        chunks.push(chunk);
        // 完整回执到达才关闭 stdin；继续读至 close，以拒绝多余帧。
        if (chunk.includes(10)) child.stdin.end();
      }
    });
    child.stderr.resume(); // 不导出原始 stderr，页面/运行时异常不能成为宿主日志通道。
    child.stdin.on('error', () => cancel('TRANSPORT_CLOSED', 'guest 输入通道提前关闭'));
    child.once('error', () => cancel('SPAWN_FAILED', '无法启动 guest 传输'));
    child.once('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      try {
        if (failure) throw failure;
        if (code !== 0) throw new GuestBrowserError('GUEST_EXIT', 'guest 传输未正常退出', false);
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        if (!raw.endsWith('\n') || raw.slice(0, -1).includes('\n'))
          throw new GuestBrowserError('FRAME_INVALID', 'guest 必须只返回一条完整 JSON 回执', false);
        resolve(validateGuestCapture(JSON.parse(raw), request));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.write(JSON.stringify(request) + '\n');
  });
}

/** 截图独立保存，资源包只带其摘要；空间存储仍使用既有 ResourceStore。 */
export async function saveGuestCapture(store: ResourceStore, artifactRoot: string, result: GuestBrowserSuccess) {
  validateGuestCapture(result, {
    operation: 'capture',
    url: GUEST_BROWSER_URL,
    sandboxName: GUEST_BROWSER_SANDBOX,
    captureId: result.snapshot.captureId,
  });
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const artifact = path.join(artifactRoot, `${result.snapshot.captureId}-${result.snapshot.screenshotSha256}.png`);
  const temporary = path.join(artifactRoot, `.capture-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(Buffer.from(result.screenshot.base64, 'base64'));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, artifact);
  } finally {
    await rm(temporary, { force: true });
  }
  const collection = await store.save('taskflow-demo', result.snapshot);
  const resource = collection.resources.find((item) => item.url === result.snapshot.url)!;
  return { collection, resource, screenshotArtifact: artifact };
}
