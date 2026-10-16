import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  AppControlResultSchema,
  MotaMapReadSchema,
  MotaMapSetReceiptSchema,
  MotaStateSchema,
  MOTA_MAP_WRITE_SCOPE,
  MOTA_PLAY_SCOPE,
  type AppControlResult,
  type AppToolName,
  type WorkbenchRun,
} from '../packages/protocol/src';
import { chooseImportSource } from './edu-import-fixture';
import { launchApp, setWindowSize, workspaceSnapshot, workshopNavigate } from './helpers';
import {
  cleanupMotaAgentWork,
  cleanMotaRun,
  closeMotaOwnedElectron,
  compactMotaApp,
  compactMotaRun,
  followMotaFixedRoute,
  MOTA_FIXED_ROUTE,
  MOTA_FIXED_ROUTE_PROMPT,
  motaBounded,
  motaMcpBusinessResult,
  motaRouteState,
  prepareMotaAgentAttempt,
  writeMotaAgentReceipt,
  type MotaRouteState,
} from './mota-agent-live-helpers';
import { motaInputAudit, readMotaOwnedFloor, startMotaAuditLifetime, type MotaProcessIdentity } from './mota-agent-live-runtime';

const workspaceId = 'taskflow-demo';
const Floor = z.object({ floorId: z.literal('MT1'), map: z.array(z.array(z.number().int())) }).passthrough();
const parseFloor = (bytes: Buffer) =>
  Floor.parse(
    JSON.parse(
      bytes
        .toString('utf8')
        .replace(/^\s*main\.floors\.MT1\s*=\s*/, '')
        .replace(/;?\s*$/, ''),
    ),
  );
type ToolReceipt = { id: string; tool: string; args: unknown; ok: boolean; state?: MotaRouteState; data?: unknown; error?: unknown };
const same = (state: MotaRouteState, expected: Record<string, unknown>) =>
  Object.entries(expected).every(([key, value]) => state[key as keyof MotaRouteState] === value);

/** Verify a real model's observed tool trajectory; scripted inputs are never used to complete a model route. */
function verifyModelRoute(receipts: ToolReceipt[], coin: boolean) {
  const observations = receipts.flatMap((receipt) => (receipt.state ? [receipt.state] : []));
  let next = 0;
  expect(
    observations.some((state) => same(state, { floorId: 'MT1', x: 6, y: 11, hp: 1000, money: 0, coin: 0 })),
    'real new-game receipt required',
  ).toBe(true);
  for (const stage of MOTA_FIXED_ROUTE) {
    const expected: Record<string, unknown> = { ...stage.expected, coin: coin ? 1 : 0 };
    if (stage.label === 'mt1-three-slimes') expected['money'] = coin ? 8 : 4;
    if (stage.label === 'mt3-two-slimes' || stage.label === 'mt4-reached') expected['money'] = coin ? 14 : 7;
    const found = observations.findIndex(
      (state, index) => index >= next && same(state, expected) && !state.lockControl && !state.heroMoving,
    );
    expect(found, 'missing ordered real-tool checkpoint: ' + stage.label).toBeGreaterThanOrEqual(0);
    next = found + 1;
  }
  const last = observations.at(-1);
  if (!last) throw new Error('real model supplied no observed state');
  return last;
}

for (const model of [false, true])
  test(
    model
      ? 'real built-in Mota AI: fixed route then CAS coin and fresh-route comparison'
      : 'scripted no-model Mota dispatcher: fixed route then CAS coin and fresh-route comparison',
    async () => {
      test.skip(
        process.env[model ? 'WSL_MOTA_MODEL_LIVE' : 'WSL_MOTA_TOOLS_LIVE'] !== '1',
        model
          ? 'explicit real model and existing-guest authorization required'
          : 'explicit existing-guest and window authorization required',
      );
      test.setTimeout(1_200_000);
      const config = await prepareMotaAgentAttempt();
      expect(config.mode).toBe(model ? 'real-model' : 'scripted-no-model');
      const sourceBefore = await motaInputAudit(config.sourceRoot);
      const evidence: Record<string, unknown> = {
        mode: config.mode,
        target: 'build',
        startedAt: new Date().toISOString(),
        result: 'running',
        sourceSha256: config.expectedSha,
        sourceAuditBefore: sourceBefore,
        picker: 'native directory reply automated; real Main collector, dispatcher, CDP, service and managed server',
        executor: model
          ? 'real built-in model via confirmed product session'
          : 'test wrapper substitutes the Codex process only; real service send/register/acquire, scope, dispatcher, CDP and map persistence; no native MCP/model proof',
        notCovered: [
          'signed package',
          'user acceptance',
          'general arbitrary code editing',
          'original Downloads project',
          'microphone',
          'Azure',
        ],
      };
      const failures: string[] = [];
      const stage = async (label: string) => {
        evidence['stage'] = label;
        console.info(`[mota-agent-live] ${config.mode} ${label}`);
        await writeFile(
          path.join(config.evidenceRoot, 'progress.json'),
          JSON.stringify({ stage: label, at: new Date().toISOString(), mode: config.mode }, null, 2),
          { mode: 0o600 },
        );
      };
      let app: ElectronApplication | undefined;
      let page: Page | undefined;
      let lifetime: Awaited<ReturnType<typeof startMotaAuditLifetime>> | undefined;
      let projectId: string | undefined;
      const runIds: string[] = [];
      const roundAudits: Array<Record<string, unknown>> = [];
      evidence['rounds'] = roundAudits;
      let processIdentities: MotaProcessIdentity[] = [];
      const state = async () => {
        if (!page) throw new Error('owned window unavailable');
        const workspace = (await workspaceSnapshot(page)).workspaces.find((item) => item.workspaceId === workspaceId);
        if (!workspace) throw new Error('owned workspace unavailable');
        return workspace;
      };
      try {
        await stage('preflight');
        lifetime = await startMotaAuditLifetime(config.binary, config.sandbox);
        evidence['runtime'] = { initialState: lifetime.initialState, baseline: lifetime.baseline, keeperPid: lifetime.keeperPid };
        ({ app, page } = await launchApp({ live: true, userData: config.profile, motaModelTurnInjection: !model }));
        const ownedApp = app;
        const ownedPage = page;
        await setWindowSize(app, 1440, 900);
        const injected = await app.evaluate(
          () => typeof (globalThis as typeof globalThis & { __wslMotaModelTurn?: unknown }).__wslMotaModelTurn !== 'undefined',
        );
        expect(injected).toBe(!model);
        evidence['modelProcessReplaced'] = injected;
        await expect
          .poll(() => ownedPage.evaluate(async () => (await window.studio.chat.getStatus()).available), { timeout: 60_000 })
          .toBe(true);
        const status = await page.evaluate(() => window.studio.chat.getStatus());
        expect(status.sandbox).toBe(config.sandbox);
        evidence['runtimeReadiness'] = {
          available: status.available,
          sandbox: status.sandbox,
          version: status.version,
          provesModelConnection: false,
        };
        await workshopNavigate(page, '空间');
        await page.getByRole('button', { name: '新建 App', exact: true }).click();
        await chooseImportSource(app, config.sourceRoot);
        await page.getByRole('button', { name: '导入已有工程', exact: true }).click();
        await expect.poll(async () => (await state()).appImport?.phase, { timeout: 30_000 }).toBe('ready');
        expect((await state()).appImport?.preview).toMatchObject({ profile: 'mota-web', sourceSha256: config.expectedSha });
        expect(await lifetime.ports()).toEqual(lifetime.baseline);
        await page.getByRole('button', { name: '确认导入并启动', exact: true }).click();
        await expect
          .poll(
            async () => {
              const current = (await state()).managedApp;
              if (current?.state === 'failed') throw new Error('owned App start failed: ' + current.error);
              return current?.state;
            },
            { timeout: 180_000 },
          )
          .toBe('running');
        await expect(page.getByRole('dialog', { name: '空间 App' })).not.toBeVisible();
        const running = (await state()).managedApp;
        if (!running?.url || !running.appInstanceId) throw new Error('owned running identity unavailable');
        projectId = running.projectId;
        evidence['app'] = compactMotaApp(running);
        evidence['ownedBinding'] = await lifetime.assertBinding(running.url, running.guestPort);
        await expect
          .poll(
            async () => {
              const resource = (await state()).resources.find((item) => item.appProjectId === projectId && item.appPage === 'game');
              return !!resource?.preview && ownedApp.windows().some((candidate) => candidate.url() === running.url + '/index.html');
            },
            { timeout: 30_000 },
          )
          .toBe(true);
        const gameResource = (await state()).resources.find((item) => item.appProjectId === projectId && item.appPage === 'game');
        if (!gameResource?.preview) throw new Error('owned game resource unavailable');
        const game = app.windows().find((candidate) => candidate.url() === running.url + '/index.html');
        if (!game) throw new Error('owned native game page unavailable');
        await game.waitForLoadState('domcontentloaded', { timeout: 30_000 });
        await expect(game.locator('#playGame')).toBeVisible({ timeout: 30_000 });
        expect(await game.evaluate(async () => (await fetch('/api/health')).json())).toMatchObject({
          identity: { workspaceId, projectId, appInstanceId: running.appInstanceId },
        });
        const original = await readMotaOwnedFloor(config.binary, config.sandbox, projectId, running.guestPort ?? null);
        expect(original.processes.length).toBeGreaterThan(0);
        processIdentities = original.processes;
        expect(parseFloor(original.bytes).map[10]?.[6]).toBe(0);
        await writeFile(path.join(config.evidenceRoot, 'MT1-before.js'), original.bytes, { flag: 'wx', mode: 0o600 });
        await stage('imported');

        for (const coin of [false, true]) {
          const label = coin ? 'coin' : 'normal';
          const sessionId = (await state()).sessions[0]?.sessionId;
          if (!sessionId) throw new Error('fresh owned session unavailable');
          const located = await page.evaluate(
            (sessionId) =>
              window.studio.workbench.command({
                type: 'locateSession',
                commandId: crypto.randomUUID(),
                workspaceId: 'taskflow-demo',
                sessionId,
              }),
            sessionId,
          );
          expect(located.ok).toBe(true);
          const session = page.getByRole('region', { name: 'Agent 会话内容' });
          await session.getByRole('button', { name: '任务', exact: true }).click();
          await expect(session.getByRole('heading', { name: '任务与版本', exact: true })).toBeVisible();
          if (coin) await session.getByLabel('任务版本').selectOption('');
          await session.getByLabel('附加目标（明确选择）').selectOption(gameResource.resourceId);
          const coinGoal = coin
            ? '先app.mota.map.read读取本实例MT1，确认(6,10)为0，用返回的sha256作expectedSha256调用app.mota.map.set，只把(6,10)置幸运金币53。然后必须newGame重新加载并走同一路线。'
            : '本轮禁止地图写入，使用未修改的原始隔离副本。';
          const goal = `${coinGoal}\n${MOTA_FIXED_ROUTE_PROMPT}\n仅使用原生MCP app_mota_state/act/map_read/map_set，无CLI或shell回退，不读文件/凭据、不安装、不改任意JS，不停止服务。每次act都返回完整state，复用它验证，不重复调用state。关键路标结束时应空闲，工具总调用须少于64。`;
          // A remounted textarea contains its saved initial text. Match the stable
          // label caption, not the enclosing label's text including that draft.
          const goalField = session
            .locator('label')
            .filter({ has: page.getByText('修改目标', { exact: true }) })
            .getByRole('textbox');
          await expect(goalField).toHaveCount(1);
          await goalField.fill(goal);
          await session.getByLabel('允许 AI 操作游戏（含重新开始）', { exact: true }).check();
          await session.getByLabel('允许 AI 在一楼空格放置幸运金币', { exact: true }).setChecked(coin);
          await session
            .getByLabel('验收条件（每行一条）')
            .fill('真实新局固定路线到MT4(11,10)\n只用获准Mota工具，角色状态只由游戏规则改变\n完整保留真实工具回执，不声称用户接受');
          await session.getByRole('button', { name: '确认任务（生成新版本）', exact: true }).click();
          const version = (await state()).sessions.find((item) => item.sessionId === sessionId)?.taskVersions.at(-1);
          if (!version?.motaTask) throw new Error('confirmed Mota binding missing');
          expect(version.allowedScopes).toEqual(coin ? [MOTA_PLAY_SCOPE, MOTA_MAP_WRITE_SCOPE] : [MOTA_PLAY_SCOPE]);
          expect(version.motaTask).toMatchObject({ projectId, appInstanceId: running.appInstanceId, resourceId: gameResource.resourceId });
          await session.getByRole('button', { name: '开始运行', exact: true }).click();
          let run: WorkbenchRun | undefined;
          await expect
            .poll(
              async () => {
                run = (await state()).runs.find((item) => item.taskVersionId === version.taskVersionId);
                return !!run;
              },
              { timeout: 30_000 },
            )
            .toBe(true);
          if (!run) throw new Error('owned run missing');
          runIds.push(run.runId);
          const runId = run.runId;
          const receipts: ToolReceipt[] = [];
          const round: Record<string, unknown> = {
            runId,
            mode: config.mode,
            tools: 0,
            capturedOutputTruncated: false,
            laterUiOutputTruncated: false,
            checkpoints: [],
          };
          roundAudits.push(round);
          const opened = await page.evaluate(() =>
            window.studio.workbench.command({
              type: 'openAppPage',
              commandId: crypto.randomUUID(),
              workspaceId: 'taskflow-demo',
              page: 'game',
            }),
          );
          expect(opened.ok).toBe(true);
          await stage(label + '-started');
          let routeEnd: MotaRouteState;

          if (!model) {
            await expect
              .poll(
                () =>
                  ownedApp.evaluate(() => {
                    const injected = (globalThis as typeof globalThis & { __wslMotaModelTurn?: { ready: boolean; runId: string | null } })
                      .__wslMotaModelTurn;
                    return injected?.ready ? injected.runId : null;
                  }),
                { timeout: 30_000 },
              )
              .toBe(runId);
            let calls = 0;
            const call = async (tool: AppToolName, args: Record<string, unknown>) => {
              if (++calls >= 64) throw new Error('scripted route tool budget must remain below 64');
              const result = AppControlResultSchema.parse(
                await motaBounded(
                  ownedApp.evaluate(
                    (_electron, input) =>
                      (
                        globalThis as typeof globalThis & { __wslMotaCall(tool: string, args: unknown): Promise<AppControlResult> }
                      ).__wslMotaCall(input.tool, input.args),
                    { tool, args },
                  ),
                  30_000,
                  'owned scripted tool timed out',
                ),
              );
              round['tools'] = calls;
              if (!result.ok) {
                const receipt = { id: String(calls), tool, args, ok: false, error: result.error };
                receipts.push(receipt);
                await writeMotaAgentReceipt(config.evidenceRoot, `${label}-scripted-tool-${calls}.json`, receipt);
                throw new Error(JSON.stringify(result.error));
              }
              expect(result.tool).toBe(tool);
              const observed = tool === 'app.mota.state' || tool === 'app.mota.act' ? MotaStateSchema.parse(result.data) : null;
              const receipt = {
                id: String(calls),
                tool,
                args,
                ok: true,
                ...(observed ? { state: motaRouteState(observed) } : { data: result.data }),
              };
              receipts.push(receipt);
              await writeMotaAgentReceipt(config.evidenceRoot, `${label}-scripted-tool-${calls}.json`, receipt);
              return result.data;
            };
            let current = MotaStateSchema.parse(await call('app.mota.state', {}));
            if (coin) {
              const map = MotaMapReadSchema.parse(await call('app.mota.map.read', { appInstanceId: current.appInstanceId }));
              expect(map.sha256).toBe(original.sha256);
              expect(map.map[10]?.[6]).toBe(0);
              const saved = MotaMapSetReceiptSchema.parse(
                await call('app.mota.map.set', { appInstanceId: current.appInstanceId, expectedSha256: map.sha256, x: 6, y: 10 }),
              );
              expect(saved.change).toEqual({ x: 6, y: 10, before: 0, after: 53 });
            }
            const route = await followMotaFixedRoute(
              {
                state: async () => {
                  current = MotaStateSchema.parse(await call('app.mota.state', {}));
                  return motaRouteState(current);
                },
                act: async (action) => {
                  current = MotaStateSchema.parse(
                    await call('app.mota.act', {
                      appInstanceId: current.appInstanceId,
                      documentGeneration: current.documentGeneration,
                      action,
                    }),
                  );
                  return motaRouteState(current);
                },
              },
              coin,
              async (receipt) => {
                console.info(`[mota-agent-live] ${label} ${receipt.label}`);
                round['checkpoints'] = [...(Array.isArray(round['checkpoints']) ? round['checkpoints'] : []), receipt.label];
                await writeMotaAgentReceipt(config.evidenceRoot, `${label}-${receipt.label}.json`, receipt);
              },
            );
            const last = route.at(-1);
            if (!last) throw new Error('scripted route has no checkpoints');
            routeEnd = last.state;
            const cancelled = await page.evaluate(
              (runId) =>
                window.studio.workbench.command({ type: 'cancelRun', commandId: crypto.randomUUID(), workspaceId: 'taskflow-demo', runId }),
              runId,
            );
            expect(cancelled.ok).toBe(true);
            await expect
              .poll(
                async () => {
                  const currentRun = (await state()).runs.find((item) => item.runId === runId);
                  if (!currentRun) throw new Error('owned run disappeared during cancellation');
                  return cleanMotaRun(currentRun);
                },
                { timeout: 45_000 },
              )
              .toBe(true);
          } else {
            const captured = new Set<string>();
            const deadline = Date.now() + 420_000;
            for (;;) {
              run = (await state()).runs.find((item) => item.runId === runId);
              if (!run) throw new Error('owned model run disappeared');
              for (const tool of run.conversation?.toolExecutions ?? []) {
                if (tool.turnId !== run.executionBinding?.turnId && tool.turnId !== run.conversation?.turnId) continue;
                if (tool.exitCode === null) continue;
                if (captured.has(tool.id)) {
                  if (tool.truncated) round['laterUiOutputTruncated'] = true;
                  continue;
                }
                round['capturedOutputTruncated'] = tool.truncated;
                expect(tool.truncated, 'uncaptured model tool receipt was truncated').toBe(false);
                expect(tool.exitCode).toBe(0);
                const match = /^mcp:wsl_space\.app_mota_(state|act|map_read|map_set) (.*)$/.exec(tool.command);
                if (!match) throw new Error('model used a tool outside the authorized native Mota MCP boundary');
                const result = AppControlResultSchema.parse(motaMcpBusinessResult(tool.output));
                if (!result.ok) {
                  round['tools'] = receipts.length + 1;
                  const failed = { id: tool.id, tool: result.tool, ok: false, error: result.error };
                  await writeMotaAgentReceipt(config.evidenceRoot, `${label}-model-tool-${receipts.length + 1}.json`, failed);
                  throw new Error('real model Mota tool failed: ' + JSON.stringify(result.error));
                }
                if (!match[2]) throw new Error('native Mota MCP arguments missing');
                const args: unknown = JSON.parse(match[2]);
                const observed =
                  result.tool === 'app.mota.state' || result.tool === 'app.mota.act' ? MotaStateSchema.parse(result.data) : null;
                receipts.push({
                  id: tool.id,
                  tool: result.tool,
                  args,
                  ok: true,
                  ...(observed ? { state: motaRouteState(observed) } : { data: result.data }),
                });
                captured.add(tool.id);
                round['tools'] = receipts.length;
                await writeMotaAgentReceipt(config.evidenceRoot, `${label}-model-tool-${receipts.length}.json`, receipts.at(-1));
              }
              if (cleanMotaRun(run)) {
                expect(
                  run.conversation?.toolExecutions.filter((tool) => tool.turnId === run?.conversation?.turnId && tool.exitCode === null),
                ).toEqual([]);
                break;
              }
              if (Date.now() >= deadline) throw new Error('real model route did not finish within its authorized bound');
              await delay(200);
            }
            expect(run.state, run.error ?? undefined).toBe('completed');
            expect(receipts.length).toBeGreaterThan(0);
            expect(receipts.length).toBeLessThan(64);
            expect(receipts.filter((item) => item.tool === 'app.mota.map.set')).toHaveLength(coin ? 1 : 0);
            routeEnd = verifyModelRoute(receipts, coin);
            round['checkpoints'] = MOTA_FIXED_ROUTE.map((item) => item.label);
          }
          await writeMotaAgentReceipt(config.evidenceRoot, label + '-tool-receipts.json', receipts);
          expect(routeEnd).toMatchObject({ floorId: 'MT4', x: 11, y: 10, hp: 926, money: coin ? 14 : 7, coin: coin ? 1 : 0 });
          const floor = await readMotaOwnedFloor(config.binary, config.sandbox, projectId, running.guestPort ?? null, processIdentities);
          if (!coin) expect(floor.bytes.equals(original.bytes)).toBe(true);
          else {
            const expected = parseFloor(original.bytes);
            const row = expected.map[10];
            if (!row || row[6] !== 0) throw new Error('original coin cell unavailable');
            row[6] = 53;
            expect(parseFloor(floor.bytes)).toEqual(expected);
            expect(floor.sha256).not.toBe(original.sha256);
            const saved = MotaMapSetReceiptSchema.parse(receipts.find((item) => item.tool === 'app.mota.map.set')?.data);
            expect(saved).toMatchObject({
              beforeSha256: original.sha256,
              afterSha256: floor.sha256,
              change: { x: 6, y: 10, before: 0, after: 53 },
            });
            await writeFile(path.join(config.evidenceRoot, 'MT1-after.js'), floor.bytes, { flag: 'wx', mode: 0o600 });
          }
          const endedRun = (await state()).runs.find((item) => item.runId === runId);
          if (!endedRun) throw new Error('owned run missing at receipt');
          evidence[label] = {
            result: routeEnd,
            run: compactMotaRun(endedRun),
            floorSha256: floor.sha256,
            tools: receipts.length,
          };
          await game.screenshot({ path: path.join(config.evidenceRoot, label + '-mt4.png') });
          await stage(label + '-completed');
        }
        evidence['result'] = 'passed';
      } catch (error) {
        failures.push(String(error));
        evidence['result'] = 'failed';
        if (page && !page.isClosed()) {
          try {
            const current = (await motaBounded(state(), 5_000, 'failure status timeout')).managedApp;
            evidence['failureApp'] = current ? compactMotaApp(current) : null;
            await page.screenshot({ path: path.join(config.evidenceRoot, 'failure-owned-app.png'), timeout: 5_000 });
          } catch (observationError) {
            evidence['failureObservationError'] = String(observationError);
          }
        }
      } finally {
        if (page && !projectId && !page.isClosed()) {
          try {
            const owned = await motaBounded(state(), 5_000, 'capture owned import identity timed out');
            if (owned.managedApp?.profile?.projectKind === 'mota-web' && owned.managedApp.sourceSha256 === config.expectedSha)
              projectId = owned.managedApp.projectId;
          } catch (error) {
            failures.push('owned import cleanup identity: ' + String(error));
          }
        }
        if (page && projectId && !page.isClosed()) {
          const cleanup = await cleanupMotaAgentWork(page, { projectId, runIds });
          evidence['workCleanup'] = cleanup.receipts;
          failures.push(...cleanup.errors);
        }
        if (app) {
          const closed = await closeMotaOwnedElectron(app);
          evidence['electronExit'] = closed.receipt;
          failures.push(...closed.errors);
        }
        if (projectId) {
          try {
            const final = await readMotaOwnedFloor(config.binary, config.sandbox, projectId, null, processIdentities);
            evidence['finalGuestAudit'] = { sha256: final.sha256, remaining: final.remaining };
            expect(final.remaining).toEqual([]);
          } catch (error) {
            failures.push('guest cleanup: ' + String(error));
          }
        }
        if (lifetime) {
          try {
            evidence['finalPorts'] = await lifetime.ports();
            expect(evidence['finalPorts']).toEqual(lifetime.baseline);
          } catch (error) {
            failures.push('port cleanup: ' + String(error));
          }
          const closed = await lifetime.close();
          evidence['keeperExit'] = closed;
          failures.push(...closed.errors);
        }
        try {
          const after = await motaInputAudit(config.sourceRoot);
          evidence['sourceAuditAfter'] = after;
          expect(after).toEqual(sourceBefore);
        } catch (error) {
          failures.push('input integrity: ' + String(error));
        }
        evidence['failures'] = failures;
        evidence['endedAt'] = new Date().toISOString();
        if (failures.length) evidence['result'] = 'failed';
        await writeMotaAgentReceipt(config.evidenceRoot, 'result.json', evidence);
      }
      expect(failures).toEqual([]);
    },
  );
