# Scoped implementation delivery

Candidate: `/private/tmp/wsl-consolidate-review-20261011`, HEAD `ea3bad9e6602ccec3484cc55b247bae5815975b4` plus uncommitted integration. All original worktrees remained read-only. No commit/push/live model/sandbox/signing.

## Import

Imported source-00 staged/unstaged patches, preserving the tracked server/db-cli.ts deletion; validated all tar paths and regular-file/directory types, imported 974 frozen files and verified every SHA-256 against manifest.json. Excluded 11 pycache/pyc/root premium-audit files.

## Fixes and regression baselines

- AppControl dispatch returned old successful results after App instance, Browser resource instance, or run changed. Four gated tests failed before the fix; all non-restart results now recheck the original identity. Restart explicitly accepts its lifecycle transition. Context uses the frozen workspace scope, never UI focus.
- AppUiDriver bridge/query accepted results after navigation/cancel/detach. Six gated tests failed before the fix. Two more tests failed for navigation during Runtime.releaseObjectGroup cleanup. Guards now check the document/connection/cancel after awaited cleanup before successful return.
- AppService stopped CLI could launch after stop was requested while admission persistence awaited. The frozen-registry write gate observed an extra guest launch (2 instead of 1). agentAdmission now reserves launch ownership; stop waits for admission, which rechecks stop/cancel before spawning. The same negative case confirms no extra process and stopped/cleanupConfirmed=true.

## Source-01 integration

Ported stable App metadata, name/description editing, revision conflict checks, creation save failure rollback and failed-create identity retention. Main remains the writer; managedApp remains runtime state. Task versions freeze appTarget/project/guestCwd and complete page/element context (without screenshots). StartRun rejects stale project/cwd and complete prompt budgets above 32000 before creating a run, preserving the existing asynchronous launch state machine and reference snapshots.

Persistence writes schema4. Legacy v1/v2 keep existing resource migration; v3 keeps its complete catalog. All older versions derive missing stable App metadata and retain exact original bytes in existing legacy-schema-N backups; future versions fail parsing. Three migration tests verify stable identity, v4 reload, exact backup bytes, and v3 catalog equality.

UI retains the current toolbar icons and ManagedAppDialog; creation/edit opens a stable SpacePage AppEditor and shared AppFormDialog, with frozen recipient, IME handling, busy protection, retained failure drafts, and viewport-compatible fields. Source-01 and existing fixture/live E2E entry points were adapted to the form without invoking live tests.

## Executed checks

Recorded logs in this directory: targeted-tests (11 files / 195 passed), desktop-node-typecheck, desktop-web-typecheck, e2e-typecheck, scoped lint (27 files), scoped format, diff-check; all exit 0.

Additional executed commands, observed in the task tool transcript: App MCP test initially blocked by UNIX socket bind EPERM in sandbox; same existing test rerun with reviewed escalation passed 2 tests (14 Python subcases). Template npm run check: 11 passed; npm run test:agent: 7 passed; npm run template:verify: passed; npm run verify:prod: production client markers absent; npm run build:agent + exclusion check --expect-present: agent markers present. No template source changed during verification.

## Remaining validation

The primary thread owns final full-repository checks, build and real Electron window E2E validation. Live model/sandbox, signed package and user acceptance were not executed by this implementation agent.

## Dual-source schema3 review fix

repository.ts now explicitly accepts the known catalog-free space-app v3 shape, requiring a nonempty workspace list and a validated explicit nullable app field on every workspace. Legacy publicResources survive parsing and feed the existing catalog migration. Catalog-bearing v3 retains full catalog and binding validation; both sources preserve original bytes before schema4 save.

Actual raw red: schema3-dual-source-red.txt (2 failed, 4 passed). Green: schema3-dual-source-green.txt (3 files, 20 passed). Node typecheck and scoped lint: schema3-dual-source-typecheck.txt and schema3-dual-source-lint.txt, exit 0. git diff --check passed. No model/sandbox live run.
