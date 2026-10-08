import { app, BrowserWindow } from 'electron';
import { z } from 'zod';
import { PreviewController } from './preview/controller';

// This host uses the production Browser view. The acceptance runner alone navigates,
// observes the DOM and captures evidence; no Workshop or competing runtime is added.
const runId = z.uuid().parse(process.env['WSL_VS001_RUN_ID']);
const previewUrl = new URL(z.url().parse(process.env['WSL_VS001_PREVIEW_URL']));
const profile = z.string().min(1).parse(process.env['WSL_VS001_PROFILE']);
if (previewUrl.protocol !== 'http:' || previewUrl.hostname !== '127.0.0.1' || previewUrl.searchParams.get('runId') !== runId)
  throw new Error('VS001 preview URL does not belong to this run');
app.setPath('userData', profile);
let window: BrowserWindow | undefined;
let preview: PreviewController | undefined;
let stopping = false;
function dispose(): void {
  if (stopping) return;
  stopping = true;
  try {
    preview?.dispose();
  } finally {
    preview = undefined;
    if (window && !window.isDestroyed()) window.destroy();
    window = undefined;
  }
}
const stop = () => {
  dispose();
  app.quit();
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.stdin.resume();
process.stdin.once('end', stop);
app.on('before-quit', dispose);
app.on('window-all-closed', () => app.quit());
void app
  .whenReady()
  .then(async () => {
    if (stopping) return;
    window = new BrowserWindow({
      title: `VS001 ${runId}`,
      width: 900,
      height: 650,
      show: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    window.once('close', dispose);
    preview = new PreviewController(window, {
      partition: `vs001-${runId}`,
      homeUrl: previewUrl.href,
      allowedOrigins: [previewUrl.origin],
      onState: () => undefined,
      onCaptured: () => {
        throw new Error('Product capture is forbidden during VS001');
      },
    });
    const target = preview.observationTarget;
    target.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    target.session.setPermissionCheckHandler(() => false);
    const layout = () => {
      if (!window || !preview) return;
      const [width, height] = window.getContentSize();
      if (width === undefined || height === undefined) throw new Error('Electron content size unavailable');
      preview.setLayout({ visible: true, bounds: { x: 0, y: 0, width, height } });
    };
    window.on('resize', layout);
    layout();
    await target.loadURL('about:blank');
    if (stopping) return;
    // Electron exposes no getTargetId(). Query only this actual WebContents' debugger
    // identity, then detach before the independent runner opens its own CDP session.
    target.debugger.attach('1.3');
    let targetId: string;
    try {
      const info: unknown = await target.debugger.sendCommand('Target.getTargetInfo');
      targetId = z
        .object({ targetInfo: z.object({ targetId: z.string().min(1), type: z.literal('page'), url: z.literal('about:blank') }) })
        .parse(info).targetInfo.targetId;
    } finally {
      if (target.debugger.isAttached()) target.debugger.detach();
    }
    if (stopping || target.isDestroyed()) return;
    process.stdout.write(`WSL_VS001:${JSON.stringify({ kind: 'vs001-ready', pid: process.pid, webContentsId: target.id, targetId })}\n`);
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    dispose();
    app.exit(1);
  });
