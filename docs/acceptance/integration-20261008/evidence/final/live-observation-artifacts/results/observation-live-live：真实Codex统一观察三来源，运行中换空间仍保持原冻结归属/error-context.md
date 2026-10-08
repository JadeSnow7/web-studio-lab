# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: observation-live.spec.ts >> live：真实Codex统一观察三来源，运行中换空间仍保持原冻结归属
- Location: e2e/observation-live.spec.ts:41:1

# Error details

```
TypeError: Cannot read properties of undefined (reading '_object')
```

# Test source

```ts
  226 |       expect(record.state).toBe('completed');
  227 |       expect(record.request).toMatchObject({ workspaceId: ownerId, sessionId: run.sessionId, runId: run.runId });
  228 |       expect(record.evidenceRef).toBeTruthy();
  229 |       expect(result).toEqual(record.result);
  230 |       if (resource) {
  231 |         expect(record.request.target).toEqual({
  232 |           workspaceId: ownerId,
  233 |           environmentId: resource.environmentId,
  234 |           resourceId: resource.resourceId,
  235 |           kind: resource.kind === 'web' ? 'browser' : resource.kind,
  236 |           instanceId: resource.instanceId,
  237 |           instanceGeneration: resource.generation,
  238 |         });
  239 |         if (!('resource' in result)) throw new Error(`Missing observation identity: ${name}`);
  240 |         expect(result.resource).toEqual(record.request.target);
  241 |         expect(result.generation).toBeTruthy();
  242 |         expect(JSON.stringify(result.data)).toContain(nonce!);
  243 |         expect(JSON.stringify(result)).not.toContain(interference);
  244 |         if (action === 'files.read') expect(result.source).toBe('disk');
  245 |         if (action === 'terminal.read_output') expect(result.data['sessionId']).toBe(terminal.terminal!.sessionId);
  246 |         if (action === 'browser.snapshot') expect(result.data['target']).toEqual({ webContentsId: browser.preview!.page!.webContentsId });
  247 |       } else {
  248 |         expect(record.request.target).toBeNull();
  249 |         if (!('kind' in result)) throw new Error('Expected source registry');
  250 |         expect(result.workspaceId).toBe(ownerId);
  251 |         expect(result.sources.every((source) => source.resource.workspaceId === ownerId)).toBe(true);
  252 |       }
  253 |     }
  254 |     const final = await workspaceSnapshot(page);
  255 |     const isolated = final.workspaces.find((w) => w.workspaceId === otherId)!;
  256 |     for (const session of isolated.sessions) {
  257 |       expect(session.observations).toHaveLength(0);
  258 |       expect(session.taskVersions).toHaveLength(0);
  259 |       for (const nonce of [browserNonce, fileNonce, terminalNonce]) expect(JSON.stringify(session)).not.toContain(nonce);
  260 |     }
  261 |     expect(isolated.runs).toHaveLength(0);
  262 |     expect(isolated.observations).toHaveLength(0);
  263 |     expect(JSON.stringify(isolated)).not.toContain(bound.runId);
  264 |     evidence['verified'] = true;
  265 |     evidence['nonces'] = { browserNonce, fileNonce, terminalNonce, interference };
  266 |     evidence['final'] = final;
  267 |   } catch (error) {
  268 |     originalFailure = error;
  269 |   } finally {
  270 |     if (app && page && ownerId) {
  271 |       try {
  272 |         const snapshot = await workspaceSnapshot(page);
  273 |         evidence['cleanupBefore'] = snapshot;
  274 |         const owner = snapshot.workspaces.find((w) => w.workspaceId === ownerId)!;
  275 |         for (const run of owner.runs.filter((r) => ['starting', 'running', 'cancelling'].includes(r.state))) {
  276 |           await command(page, { type: 'cancelRun', commandId: randomUUID(), workspaceId: ownerId, runId: run.runId });
  277 |         }
  278 |         for (const resource of owner.resources.filter((r) => r.kind === 'terminal' && r.instanceId)) {
  279 |           await command(page, {
  280 |             type: 'stopInstance',
  281 |             commandId: randomUUID(),
  282 |             workspaceId: ownerId,
  283 |             resourceId: resource.resourceId,
  284 |             instanceId: resource.instanceId!,
  285 |           });
  286 |         }
  287 |         await expect
  288 |           .poll(
  289 |             async () => {
  290 |               const w = (await workspaceSnapshot(page!)).workspaces.find((w) => w.workspaceId === ownerId)!;
  291 |               return (
  292 |                 w.runs.every((r) => !['starting', 'running', 'cancelling'].includes(r.state) && !r.conversation?.cleanupPending) &&
  293 |                 w.resources.every((r) => !r.terminal || (r.terminal.state === 'closed' && !r.terminal.cleanupPending))
  294 |               );
  295 |             },
  296 |             { timeout: 30000 },
  297 |           )
  298 |           .toBe(true);
  299 |         evidence['cleanupAfter'] = await workspaceSnapshot(page);
  300 |         processCleanupConfirmed = true;
  301 |       } catch (error) {
  302 |         cleanupErrors.push(error);
  303 |       }
  304 |       try {
  305 |         await app.close();
  306 |       } catch (error) {
  307 |         cleanupErrors.push(error);
  308 |       }
  309 |     }
  310 |     if (guestCreated && processCleanupConfirmed) {
  311 |       const clean = `import pathlib,re,shutil,sys\np=pathlib.Path(sys.argv[1])\nif p.parent != pathlib.Path('/home/agent/workspace') or not re.fullmatch(r'wsl-observation-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',p.name): raise ValueError('Unowned cleanup path')\nif p.is_symlink(): p.unlink()\nelif p.exists(): shutil.rmtree(p)\n`;
  312 |       try {
  313 |         await promisify(execFile)(
  314 |           process.env['WSL_SBX_BIN'] ?? '/opt/homebrew/bin/sbx',
  315 |           ['exec', process.env['WSL_SBX_NAME'] ?? 'wsl-sbx-smoke-20261006', 'python3', '-I', '-c', clean, guestDir],
  316 |           { timeout: 30000 },
  317 |         );
  318 |       } catch (error) {
  319 |         cleanupErrors.push(error);
  320 |       }
  321 |     }
  322 |     evidence['phase'] = phase;
  323 |     evidence['processCleanupConfirmed'] = processCleanupConfirmed;
  324 |     evidence['failure'] = originalFailure instanceof Error ? originalFailure.message : (originalFailure ?? null);
  325 |     evidence['cleanupErrors'] = cleanupErrors.map((error) => (error instanceof Error ? error.message : String(error)));
> 326 |     const applicationExited = !app || app.process().exitCode !== null || app.process().signalCode !== null;
      |                                           ^ TypeError: Cannot read properties of undefined (reading '_object')
  327 |     evidence['applicationExited'] = applicationExited;
  328 |     const output = info.outputPath('observation-live-evidence.json');
  329 |     await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
  330 |     await info.attach('observation-live-evidence', { path: output, contentType: 'application/json' });
  331 |     if (applicationExited) await rm(owned, { recursive: true, force: true });
  332 |   }
  333 |   if (cleanupErrors.length)
  334 |     throw new AggregateError(
  335 |       [...(originalFailure ? [originalFailure] : []), ...cleanupErrors],
  336 |       'Observation live failure/owned cleanup errors',
  337 |       { cause: originalFailure ?? cleanupErrors[0] },
  338 |     );
  339 |   if (originalFailure) throw originalFailure;
  340 | });
  341 | 
```