import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, realpath, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { ManagedApp, MotaState, WorkbenchRun } from '../packages/protocol/src';
import { workspaceSnapshot } from './helpers';

/** Test observations are normalized from the product's fixed Mota tool result, never arbitrary page JavaScript. */
export type MotaRouteState = {
  floorId: string | null;
  x: number | null;
  y: number | null;
  hp: number | null;
  atk: number | null;
  def: number | null;
  money: number | null;
  coin: number;
  yellowKey: number;
  blueKey: number;
  lockControl: boolean;
  heroMoving: boolean;
  eventType: string | null;
  canContinue: boolean;
};
export const motaRouteState = (state: MotaState): MotaRouteState => ({
  floorId: state.floorId,
  x: state.hero?.x ?? null,
  y: state.hero?.y ?? null,
  hp: state.hero?.hp ?? null,
  atk: state.hero?.atk ?? null,
  def: state.hero?.def ?? null,
  money: state.hero?.money ?? null,
  coin: state.hero?.coin ?? 0,
  yellowKey: state.hero?.keys.yellow ?? 0,
  blueKey: state.hero?.keys.blue ?? 0,
  lockControl: state.locked,
  heroMoving: state.moving,
  eventType: state.event.id ? state.event.type : null,
  canContinue: state.dialogue?.canContinue === true,
});

/** The adapter must call the real run-scoped product dispatcher; this interface cannot mutate game state directly. */
export type MotaRouteDriver = {
  state(): Promise<MotaRouteState>;
  act(
    action: { type: 'newGame' } | { type: 'continue' } | { type: 'tile'; floorId: string; x: number; y: number },
  ): Promise<MotaRouteState>;
};

type Position = { floorId: string; x: number; y: number };
type RouteStep = { target: Position; expected: Position };
export type MotaRouteReceipt = { label: string; at: string; state: MotaRouteState; inputs: number; continues: number };

const samePosition = (state: MotaRouteState, expected: Position) =>
  state.floorId === expected.floorId && state.x === expected.x && state.y === expected.y;
const idle = (state: MotaRouteState) => !state.lockControl && !state.heroMoving && state.eventType === null;
const tile = (floorId: string, x: number, y: number, expected: Position = { floorId, x, y }): RouteStep => ({
  target: { floorId, x, y },
  expected,
});

/**
 * Frozen source route. Stair destinations use floor.downFloor, not the visible stair cell:
 * MT2 (1,2), MT3 (2,11), MT4 (11,10). The ambush itself changes hero stats and teleports to MT2 (3,8).
 */
export const MOTA_FIXED_ROUTE = [
  {
    label: 'coin-cell',
    steps: [tile('MT1', 6, 10)],
    expected: { floorId: 'MT1', x: 6, y: 10, money: 0 },
  },
  {
    label: 'first-yellow-door',
    steps: [tile('MT1', 5, 10), tile('MT1', 6, 10), tile('MT1', 6, 9)],
    expected: { floorId: 'MT1', x: 6, y: 9, yellowKey: 0, money: 0 },
  },
  {
    label: 'mt1-three-slimes',
    steps: [
      tile('MT1', 6, 8),
      tile('MT1', 11, 8),
      tile('MT1', 11, 1),
      tile('MT1', 6, 1),
      tile('MT1', 5, 1),
      tile('MT1', 4, 1),
      tile('MT1', 3, 1),
    ],
    expected: { floorId: 'MT1', x: 3, y: 1, hp: 1000 },
  },
  {
    label: 'first-mt2',
    steps: [tile('MT1', 1, 1, { floorId: 'MT2', x: 1, y: 2 })],
    expected: { floorId: 'MT2', x: 1, y: 2 },
  },
  {
    label: 'first-mt3',
    steps: [tile('MT2', 1, 11, { floorId: 'MT3', x: 2, y: 11 })],
    expected: { floorId: 'MT3', x: 2, y: 11 },
  },
  {
    label: 'ambush-resolved',
    steps: [tile('MT3', 5, 11), tile('MT3', 5, 9, { floorId: 'MT2', x: 3, y: 8 })],
    expected: { floorId: 'MT2', x: 3, y: 8, hp: 400, atk: 10, def: 10 },
  },
  {
    label: 'thief-first-dialogue',
    steps: [tile('MT2', 3, 7)],
    expected: { floorId: 'MT2', x: 3, y: 7 },
  },
  {
    label: 'thief-second-dialogue',
    steps: [tile('MT2', 1, 7), tile('MT2', 1, 8), tile('MT2', 1, 9)],
    expected: { floorId: 'MT2', x: 1, y: 9 },
  },
  {
    label: 'second-mt3',
    steps: [tile('MT2', 1, 11, { floorId: 'MT3', x: 2, y: 11 })],
    expected: { floorId: 'MT3', x: 2, y: 11 },
  },
  {
    label: 'mt3-nine-grid',
    steps: [
      tile('MT3', 5, 11),
      tile('MT3', 5, 3),
      tile('MT3', 4, 3),
      tile('MT3', 4, 1),
      tile('MT3', 6, 1),
      tile('MT3', 6, 2),
      tile('MT3', 5, 2),
      tile('MT3', 5, 3),
      tile('MT3', 6, 3),
      tile('MT3', 5, 3),
    ],
    expected: { floorId: 'MT3', x: 5, y: 3, hp: 1000, yellowKey: 5, blueKey: 1 },
  },
  {
    label: 'mt3-two-slimes',
    steps: [tile('MT3', 7, 5), tile('MT3', 8, 5), tile('MT3', 8, 10)],
    expected: { floorId: 'MT3', x: 8, y: 10, hp: 926 },
  },
  {
    label: 'mt4-reached',
    steps: [tile('MT3', 8, 11), tile('MT3', 9, 11), tile('MT3', 11, 11, { floorId: 'MT4', x: 11, y: 10 })],
    expected: { floorId: 'MT4', x: 11, y: 10, hp: 926, atk: 10, def: 10, yellowKey: 4, blueKey: 1 },
  },
] as const;

export const MOTA_FIXED_ROUTE_PROMPT = `从真实新局沿指定路线走到MT4，不载入旧存档、不改角色、HP、money或route、不调用内部移动/回放函数。
先走MT1(6,10)，取(5,10)黄钥匙，开(6,9)黄门，经(6,8)、右边走廊到顶行，依次打(5,1)绿史莱姆、(4,1)红史莱姆、(3,1)绿史莱姆，(1,1)上楼。
MT2自然落点(1,2)，沿x=1到(1,11)上楼；MT3落点(2,11)，经(5,11)(5,10)到(5,9)触发伏击，等待原剧情自然把勇者移到MT2(3,8)。
只在工具报告文本对话时continue；其余忙碌期间只读取state等待，不盲目连续确认。与MT2(3,7)小偷交谈；对话结束后必须再次tile点击原NPC格(3,7)，以完整act回执确认勇者已站到MT2(3,7)、locked=false且moving=false，才可继续。经过(2,7)(1,7)(1,8)再与(1,9)小偷交谈；对话结束后同样必须再次tile点击原NPC格(1,9)，以完整act回执确认站到MT2(1,9)、locked=false且moving=false，才可点击(1,11)回MT3。不能用直接点击下一个远处目标、途中经过NPC原格代替这两个独立停点回执。
从MT3(2,11)经(5,11)沿x=5向上到(5,3)，收集九宫格：(4,3)(4,2)(4,1)(5,1)(6,1)(6,2)(5,2)(5,3)(6,3)(5,3)。
再经(5,4)(5,5)(6,5)，打(7,5)绿史莱姆，经(8,5)沿x=8向下打(8,10)红史莱姆，经过(8,11)开(9,11)黄门，经(10,11)(11,11)上MT4，真实落点为(11,10)。
可通行长走廊直接点击上述目标点，由游戏真实寻路；不要逐格点击。初始state之后复用每次act回执state，只有忙态才必要poll，整个路线少于64次工具调用。门、怪物、NPC第一次触发可能尚未前进，等状态稳定后再点击同一格。只使用获准Mota窄工具，到MT4后停止，报告真实floor/坐标/HP/money/coin。`;

/** Bounded genuine inputs. This never calls a replay API or changes a hero/map value itself. */
export async function followMotaFixedRoute(
  driver: MotaRouteDriver,
  coin: boolean,
  record: (receipt: MotaRouteReceipt) => Promise<void>,
): Promise<MotaRouteReceipt[]> {
  const receipts: MotaRouteReceipt[] = [];
  let inputs = 0;
  let continues = 0;
  let observed = await driver.act({ type: 'newGame' });
  inputs++;
  const settle = async (step: RouteStep) => {
    const deadline = Date.now() + 30_000;
    let clicks = 0;
    while (Date.now() < deadline) {
      const state = observed;
      if (idle(state) && samePosition(state, step.expected)) return;
      if (state.canContinue) {
        if (++continues > 40) throw new Error('fixed route dialogue budget exceeded');
        observed = await driver.act({ type: 'continue' });
        inputs++;
      } else if (idle(state)) {
        if (state.floorId !== step.target.floorId || state.x === null || state.y === null)
          throw new Error('unexpected floor while following fixed route');
        if (++clicks > 4) throw new Error('fixed route tile did not resolve after four genuine inputs');
        observed = await driver.act({ type: 'tile', ...step.target });
        inputs++;
      } else {
        await delay(200);
        observed = await driver.state();
      }
      if (inputs >= 63) throw new Error('fixed route exhausted its bounded tool input budget');
    }
    throw new Error('fixed route did not settle at ' + JSON.stringify(step.expected));
  };
  expect(observed).toMatchObject({
    floorId: 'MT1',
    x: 6,
    y: 11,
    hp: 1000,
    atk: 100,
    def: 100,
    money: 0,
    coin: 0,
    yellowKey: 0,
    blueKey: 0,
    lockControl: false,
    heroMoving: false,
    eventType: null,
  });
  for (const stage of MOTA_FIXED_ROUTE) {
    for (const step of stage.steps) await settle(step);
    const state = observed;
    expect(state).toMatchObject(stage.expected);
    expect(state.coin).toBe(coin ? 1 : 0);
    if (stage.label === 'mt1-three-slimes') expect(state.money).toBe(coin ? 8 : 4);
    if (stage.label === 'mt3-two-slimes' || stage.label === 'mt4-reached') expect(state.money).toBe(coin ? 14 : 7);
    const receipt = { label: stage.label, at: new Date().toISOString(), state, inputs, continues };
    receipts.push(receipt);
    await record(receipt);
  }
  return receipts;
}

export async function prepareMotaAgentAttempt() {
  const scripted = process.env['WSL_MOTA_TOOLS_LIVE'] === '1';
  const model = process.env['WSL_MOTA_MODEL_LIVE'] === '1';
  if (scripted === model) throw new Error('select exactly one explicitly authorized Mota tools or real-model stage');
  const sourceInput = process.env['WSL_MOTA_SOURCE_ROOT'];
  const expectedSha = process.env['WSL_MOTA_EXPECTED_SHA256'];
  const evidenceRoot = process.env['WSL_MOTA_AGENT_EVIDENCE'];
  const profile = process.env['WSL_MOTA_AGENT_PROFILE'];
  const sandbox = process.env['WSL_SBX_NAME'];
  const binary = process.env['WSL_SBX_BIN'] ?? '/opt/homebrew/bin/sbx';
  if (!sourceInput || !evidenceRoot || !profile || !expectedSha || !/^[a-f0-9]{64}$/.test(expectedSha))
    throw new Error('explicit copied source/digest and fresh profile/evidence required');
  if (![sourceInput, evidenceRoot, profile, binary].every(path.isAbsolute) || sandbox !== 'wsl-sbx-smoke-20261006')
    throw new Error('only the authorized existing smoke guest and absolute paths are accepted');
  if (process.env['WSL_E2E_TARGET'] === 'packaged') throw new Error('this stage validates the current development build only');
  if (['WSL_OBSERVATION_ROOT', 'WSL_SSH_HOST', 'WSL_SSH_ROOT'].some((key) => process.env[key]))
    throw new Error('unrelated host and SSH overrides must be cleared');
  if (profile === evidenceRoot || profile.startsWith(evidenceRoot + path.sep) || evidenceRoot.startsWith(profile + path.sep))
    throw new Error('private profile must remain outside evidence');
  const sourceRoot = await realpath(sourceInput);
  if (!sourceRoot.startsWith('/private/tmp/') || (await lstat(sourceInput)).isSymbolicLink())
    throw new Error('only an existing isolated temporary source copy is accepted');
  if (
    [profile, evidenceRoot].some(
      (output) => output === sourceRoot || output.startsWith(sourceRoot + path.sep) || sourceRoot.startsWith(output + path.sep),
    )
  )
    throw new Error('source copy must remain separate from profile and evidence');
  await mkdir(evidenceRoot, { mode: 0o700 });
  await mkdir(profile, { mode: 0o700 });
  return {
    sourceRoot,
    expectedSha,
    evidenceRoot,
    profile,
    sandbox,
    binary,
    mode: model ? ('real-model' as const) : ('scripted-no-model' as const),
  };
}

/** Validate every layer: exitCode=0 alone does not establish a successful MCP business result. */
export function motaMcpBusinessResult(output: string): unknown {
  const wrapper = z
    .object({
      status: z.literal('completed'),
      result: z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })) }),
    })
    .parse(JSON.parse(output));
  expect(wrapper.result.isError).not.toBe(true);
  const text = wrapper.result.content.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('Mota MCP text receipt missing');
  return z.object({ untrusted: z.literal(true), data: z.unknown() }).parse(JSON.parse(text)).data;
}

export async function writeMotaAgentReceipt(root: string, name: string, value: unknown) {
  if (!/^[a-z0-9][a-z0-9-]*\.json$/.test(name)) throw new Error('invalid receipt name');
  await writeFile(path.join(root, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

export const compactMotaApp = (app: ManagedApp) => ({
  workspaceId: app.workspaceId,
  projectId: app.projectId,
  appInstanceId: app.appInstanceId,
  state: app.state,
  guestPort: app.guestPort,
  sourceSha256: app.sourceSha256,
  cleanupConfirmed: app.cleanupConfirmed,
  error: app.error,
});
export const compactMotaRun = (run: WorkbenchRun) => ({
  runId: run.runId,
  taskVersionId: run.taskVersionId,
  state: run.state,
  cleanupPending: run.cleanupPending,
  appCleanupPending: run.appCleanupPending,
  sourceCleanupPending: run.sourceCleanupPending,
  motaCleanupPending: run.motaCleanupPending,
  executorState: run.executorState,
});
export const cleanMotaRun = (run: WorkbenchRun) =>
  ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state) &&
  !run.cleanupPending &&
  !run.appCleanupPending &&
  !run.sourceCleanupPending &&
  !run.motaCleanupPending &&
  (run.executorState ? !run.executorState.cleanupPending : run.executionBinding === null);

export async function motaBounded<T>(operation: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Cancel only captured runs from this fresh profile, then stop only its captured imported project. */
export async function cleanupMotaAgentWork(page: Page, owned: { projectId: string; runIds: string[] }) {
  const errors: string[] = [];
  const receipts: Record<string, unknown> = {};
  const current = async () => {
    const workspace = (await motaBounded(workspaceSnapshot(page), 5_000, 'owned workspace cleanup read timed out')).workspaces.find(
      (item) => item.workspaceId === 'taskflow-demo',
    );
    if (!workspace || workspace.managedApp?.projectId !== owned.projectId) throw new Error('owned project identity changed');
    return workspace;
  };
  for (const runId of owned.runIds) {
    try {
      const run = (await current()).runs.find((item) => item.runId === runId);
      if (!run) throw new Error('owned run disappeared');
      if (!cleanMotaRun(run)) {
        const result = await motaBounded(
          page.evaluate(
            (id) =>
              window.studio.workbench.command({
                type: 'cancelRun',
                commandId: crypto.randomUUID(),
                workspaceId: 'taskflow-demo',
                runId: id,
              }),
            runId,
          ),
          45_000,
          'owned run cancellation timed out',
        );
        expect(result.ok).toBe(true);
        await expect
          .poll(
            async () => {
              const stopped = (await current()).runs.find((item) => item.runId === runId);
              if (!stopped) throw new Error('owned run disappeared during cancellation');
              receipts[runId] = compactMotaRun(stopped);
              return cleanMotaRun(stopped);
            },
            { timeout: 45_000 },
          )
          .toBe(true);
      } else receipts[runId] = compactMotaRun(run);
    } catch (error) {
      errors.push('run cleanup: ' + String(error));
    }
  }
  try {
    const before = await current();
    if (!before.managedApp?.cleanupConfirmed) {
      const result = await motaBounded(
        page.evaluate(() =>
          window.studio.workbench.command({
            type: 'stopApp',
            commandId: crypto.randomUUID(),
            workspaceId: 'taskflow-demo',
          }),
        ),
        45_000,
        'owned App stop timed out',
      );
      expect(result.ok).toBe(true);
    }
    const stopped = (await current()).managedApp;
    if (!stopped) throw new Error('owned App disappeared during stop');
    receipts['app'] = compactMotaApp(stopped);
    expect(stopped.cleanupConfirmed).toBe(true);
  } catch (error) {
    errors.push('App cleanup: ' + String(error));
  }
  return { errors, receipts };
}

/** Normal shutdown first; fallback signals target only the process handle returned by this launch. */
export async function closeMotaOwnedElectron(app: ElectronApplication) {
  const child = app.process();
  const errors: string[] = [];
  const receipt: Record<string, unknown> = { pid: child.pid };
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
      : new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          child.once('exit', (code, signal) => resolve({ code, signal }));
        });
  const alive = () => child.exitCode === null && child.signalCode === null;
  try {
    await motaBounded(app.close(), 20_000, 'owned Electron close timed out');
  } catch (error) {
    errors.push(String(error));
    if (alive()) receipt['sigtermSent'] = child.kill('SIGTERM');
  }
  try {
    const result = await motaBounded(exited, 15_000, 'owned Electron exit unconfirmed');
    receipt['exit'] = result;
    expect(result).toEqual({ code: 0, signal: null });
  } catch (error) {
    errors.push(String(error));
    if (alive()) {
      receipt['sigkillSent'] = child.kill('SIGKILL');
      try {
        receipt['forcedExit'] = await motaBounded(exited, 10_000, 'owned Electron exit unconfirmed after SIGKILL');
      } catch (forcedError) {
        errors.push(String(forcedError));
      }
    }
  }
  return { errors, receipt };
}
