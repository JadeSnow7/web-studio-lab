import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test';
import type { EduAudioReceipt } from '../apps/desktop/src/main/preview/edu-audio-monitor';
import type { PreviewController } from '../apps/desktop/src/main/preview/controller';
interface PermissionCall {
  kind: string;
  p: string;
  answer: boolean;
  d?: { isMainFrame?: boolean };
}
declare global {
  var audioHarness: {
    preview: PreviewController;
    calls: PermissionCall[];
    receipts: EduAudioReceipt[];
    states: Array<{ page: { url: string }; loadError: { description: string } | null }>;
  };
}

// A standalone harness runs the production PreviewController against a local
// student document. It has no guest, model, backend fixture API or production switch.
test('edu native audio permissions and actual track cleanup (explicit synthetic device or physical mode)', async () => {
  const mode = process.env.WSL_EDU_AUDIO_MODE ?? 'synthetic-device';
  expect(['synthetic-device', 'physical']).toContain(mode);
  const root = await mkdtemp(path.join(tmpdir(), 'wsl-edu-audio-'));
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Audio lifecycle fixture</title><button>Student audio fixture</button>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP fixture port missing');
  const origin = `http://127.0.0.1:${address.port}`;
  let app: ElectronApplication | undefined;
  try {
    const require = createRequire(createRequire(import.meta.url).resolve('vite/package.json'));
    const { build } = require('esbuild') as { build(options: Record<string, unknown>): Promise<unknown> };
    await build({
      entryPoints: [path.resolve('apps/desktop/src/main/preview/controller.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      outfile: path.join(root, 'controller.cjs'),
    });
    await writeFile(
      path.join(root, 'main.cjs'),
      `
      const {app,BrowserWindow,session} = require('electron');
      const {PreviewController} = require('./controller.cjs');
      app.setPath('userData',${JSON.stringify(path.join(root, 'profile'))});
      process.on('uncaughtException',error=>{console.error(error);app.exit(1)});
      process.on('unhandledRejection',error=>{console.error(error);app.exit(1)});
      app.on('window-all-closed',()=>app.quit());
      app.whenReady().then(async () => {
        const window = new BrowserWindow({width:800,height:600,show:true});
        await window.loadURL('about:blank');
        const calls = [];
        const partition = 'edu-audio-harness';
        const ses = session.fromPartition(partition);
        const setRequest = ses.setPermissionRequestHandler.bind(ses);
        const setCheck = ses.setPermissionCheckHandler.bind(ses);
        ses.setPermissionRequestHandler = handler => setRequest((wc,p,callback,d) => handler(wc,p,answer => {calls.push({kind:'request',p,answer,d});callback(answer)},d));
        ses.setPermissionCheckHandler = handler => setCheck((...args) => {const answer=handler(...args);calls.push({kind:'check',p:args[1],answer,d:args[3]});return answer});
        let active = true;
        const states=[];const receipts=[];
        const preview = new PreviewController(window,{partition,homeUrl:${JSON.stringify(origin + '/student')},
          allowedOrigins:[${JSON.stringify(origin)}],managedAppOrigin:()=>${JSON.stringify(origin)},onState:s=>{states.push(s);if(s.loadError)console.error('audio state error',s.loadError)},onCaptured:()=>{},
          eduAudio:()=>active ? {workspaceId:'w',resourceId:'r',instanceId:'i',instanceGeneration:1,appInstanceId:'app',origin:${JSON.stringify(origin)},activeWorkspace:true,running:true}:null});
        const send=preview.observationTarget.debugger.sendCommand.bind(preview.observationTarget.debugger);
        preview.observationTarget.debugger.sendCommand=async (method,params)=>{const result=await send(method,params);if(method==='Runtime.evaluate'&&params?.expression?.endsWith('.stop()'))receipts.push(result.result.value);return result};
        global.audioHarness={preview,window,calls,states,receipts,revoke:()=>{active=false}};
        await preview.navigate(${JSON.stringify(origin + '/student')});
        preview.setLayout({visible:true,bounds:{x:0,y:0,width:800,height:600}});
      });
    `,
    );
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    delete env.ELECTRON_RUN_AS_NODE;
    app = await test.step('launch native audio harness', () =>
      electron.launch({
        args: [path.join(root, 'main.cjs'), ...(mode === 'synthetic-device' ? ['--use-fake-device-for-media-stream'] : [])],
        env,
      }));
    await expect.poll(() => app!.evaluate(() => Boolean(globalThis.audioHarness))).toBe(true);
    // Eligibility activation must settle before native gUM enters the permission handlers.
    await expect.poll(() => app!.evaluate(() => globalThis.audioHarness.states.at(-1)?.page.url)).toBe(origin + '/student');
    expect(await app.evaluate(() => globalThis.audioHarness.states.at(-1)?.loadError)).toBeNull();
    const student = app
      .context()
      .pages()
      .find((page) => page.url() === origin + '/student');
    if (!student) throw new Error('native preview renderer target missing');
    const execute = (source: string) => student.evaluate(source);

    await execute(`globalThis.tracks=[]; globalThis.requestAudio=async constraints=>{
      try { const stream=await navigator.mediaDevices.getUserMedia(constraints); tracks.push(...stream.getTracks());return 'granted'; }
      catch(e){return e.name;} };void 0;`);
    expect(await test.step('native synthetic-device audio grant', () => execute('requestAudio({audio:true})'))).toBe('granted');
    await execute('tracks.push(tracks[0].clone()); const cloned=new MediaStream([tracks[0]]).clone();tracks.push(...cloned.getTracks());');
    expect(await execute('tracks.map(track=>track.readyState)')).toEqual(['live', 'live', 'live']);
    expect(await execute('requestAudio({audio:true,video:true})')).toBe('NotAllowedError');
    // A real subframe calls native gUM, rather than a synthetic policy invocation.
    expect(
      await execute(`(async()=>{const frame=document.createElement('iframe');document.body.append(frame);
      try {await frame.contentWindow.navigator.mediaDevices.getUserMedia({audio:true});return 'granted'}catch(e){return e.name} })()`),
    ).toBe('NotAllowedError');
    await app.evaluate(() =>
      globalThis.audioHarness.preview.setLayout({ visible: false, bounds: { x: 0, y: 0, width: 800, height: 600 } }),
    );
    await expect.poll(() => execute('tracks.map(track=>track.readyState)')).toEqual(['ended', 'ended', 'ended']);
    await app.evaluate(async () => globalThis.audioHarness.preview.stopEduAudio());
    expect(await execute('tracks.map(track=>track.readyState)')).toEqual(['ended', 'ended', 'ended']);
    expect(await execute('requestAudio({audio:true})')).toBe('NotAllowedError');
    await app.evaluate(async () => {
      globalThis.audioHarness.preview.setLayout({ visible: true, bounds: { x: 0, y: 0, width: 800, height: 600 } });
      await globalThis.audioHarness.preview.resumeEduAudio();
    });
    expect(await execute('requestAudio({audio:true})')).toBe('granted');
    // A native page navigation must stop the old document before its context goes away.
    await execute(`location.href=${JSON.stringify(origin + '/admin')};void 0`);
    await expect.poll(() => student.url()).toBe(origin + '/admin');
    expect(await execute(`navigator.mediaDevices.getUserMedia({audio:true}).then(()=> 'granted',e=>e.name)`)).toBe('NotAllowedError');
    const { calls, receipts } = await app.evaluate(() => ({
      calls: globalThis.audioHarness.calls,
      receipts: globalThis.audioHarness.receipts,
    }));
    expect(receipts.some((receipt) => receipt.tracks === 4 && receipt.ended === 4 && receipt.pending === 0)).toBe(true);
    expect(receipts.every((receipt) => receipt.tracks === receipt.ended && receipt.pending === 0)).toBe(true);
    expect(calls.some((call) => call.answer === true)).toBe(true);
    expect(calls.some((call) => call.answer === false)).toBe(true);
    expect(calls.some((call) => call.d?.isMainFrame === false && call.answer === false)).toBe(true);
    await app.evaluate(async () => globalThis.audioHarness.preview.closeWithAudioCleanup());
    const bundleSha256 = createHash('sha256')
      .update(await readFile(path.join(root, 'controller.cjs')))
      .digest('hex');
    const evidence = { mode, bundleSha256, electron: await app.evaluate(() => process.versions.electron), calls, receipts };
    const evidencePath = test.info().outputPath('native-audio-permissions.json');
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    test.info().annotations.push({ type: 'audio-mode', description: mode });
    await test.info().attach('native-audio-permissions', { path: evidencePath, contentType: 'application/json' });
  } finally {
    if (app) {
      try {
        await app.evaluate(async () => {
          if (globalThis.audioHarness) await globalThis.audioHarness.preview.closeWithAudioCleanup();
        });
      } finally {
        await app.close();
      }
    }
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true });
  }
});
