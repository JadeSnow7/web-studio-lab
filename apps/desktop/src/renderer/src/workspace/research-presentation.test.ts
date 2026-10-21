import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ManagedApp,
  ResearchCaptureSummary,
  WorkbenchResource,
  WorkbenchResult,
  WorkbenchRun,
  WorkbenchSession,
  WorkbenchSnapshot,
} from '@wsl/protocol';
import { beginNavigation, isCurrentNavigation, workspaceCommand, workspaceStore } from '../state/workspace';
import { ResearchSources } from './ResearchSources';
import {
  researchDraftEligible,
  researchSubmissionEnabled,
  researchSummaryPresentation,
  researchVersionEligible,
} from './research-presentation';

const app: ManagedApp = {
  workspaceId: 'space',
  projectId: 'project',
  environmentId: 'sandbox',
  appInstanceId: 'app-instance',
  state: 'running',
  url: 'http://127.0.0.1:4000',
  guestCwd: '/home/agent/workspace/.wsl-apps/project',
  error: null,
  cleanupConfirmed: false,
  profile: { projectKind: 'standard-app', profileVersion: 1 },
};
const resource: WorkbenchResource = {
  resourceId: 'page',
  appProjectId: 'project',
  environmentId: 'sandbox',
  kind: 'web',
  title: 'App',
  url: app.url,
  instanceId: 'browser',
  generation: 1,
  preview: null,
  terminal: null,
  unavailableReason: null,
};
const workspace = { workspaceId: 'space', managedApp: app, resources: [resource] };
const target = { kind: 'web' as const, resourceId: 'page' };
const version: WorkbenchSession['taskVersions'][number] = {
  taskVersionId: 'version',
  version: 1,
  workspaceId: 'space',
  sessionId: 'session',
  goal: 'Research',
  targetRef: target,
  capture: null,
  captureBinding: null,
  confirmedAt: '2026-10-15T00:00:00.000Z',
  acceptance: [],
  allowedScopes: [],
  appTarget: {
    workspaceId: 'space',
    projectId: 'project',
    appId: 'app',
    name: 'Journal',
    description: '',
    revision: 1,
    guestCwd: app.guestCwd,
  },
};
const capture: ResearchCaptureSummary = {
  captureId: 'capture',
  readerResourceId: 'reader',
  requestedUrl: 'https://example.org/article',
  url: 'https://example.org/article',
  title: 'Article',
  capturedAt: '2026-10-15T00:00:00.000Z',
  sourceSha256: 'a'.repeat(64),
  contentSha256: 'b'.repeat(64),
  extractionVersion: 'html-text-v1',
  truncated: false,
  textBytes: 12,
};
const run: WorkbenchRun = {
  workspaceId: 'space',
  sessionId: 'session',
  taskVersionId: 'version',
  runId: 'run',
  state: 'completed',
  startedAt: '',
  endedAt: '',
  error: null,
  candidateId: 'candidate',
  targetRef: target,
  validation: { state: 'not_run', applicability: 'unknown', reason: null },
  review: null,
  executionBinding: { generation: 'generation', turnId: 'turn' },
  conversation: {
    conversationId: 'session',
    generation: 'generation',
    seq: 1,
    threadId: null,
    turnId: 'turn',
    state: 'idle',
    messages: [],
    toolExecutions: [],
    warnings: [],
    cleanupPending: false,
    error: null,
    nativeSearches: [
      {
        itemId: 'search',
        turnId: 'turn',
        status: 'completed',
        observedAt: capture.capturedAt,
        query: 'journal references',
        candidateUrls: ['https://example.org/candidate'],
        schemaUnsupported: false,
        truncated: false,
      },
    ],
  },
  researchSummary: {
    grant: {
      grantId: 'grant',
      accountId: 'account',
      workspaceId: 'space',
      sessionId: 'session',
      taskVersionId: 'version',
      runId: 'run',
      mode: 'live',
      purpose: 'public-web-research',
      grantedAt: capture.capturedAt,
    },
    captures: [capture],
    inclusions: [],
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('research opt-in presentation', () => {
  it('permits only the current same-project running standard App target', () => {
    expect(researchDraftEligible(workspace, target)).toBe(true);
    for (const current of [
      { ...workspace, managedApp: null },
      { ...workspace, managedApp: { ...app, profile: undefined } },
      { ...workspace, managedApp: { ...app, state: 'stopped' as const } },
      { ...workspace, managedApp: { ...app, projectId: 'other-project' } },
      { ...workspace, managedApp: { ...app, workspaceId: 'other-space' } },
      { ...workspace, managedApp: { ...app, appInstanceId: null } },
      { ...workspace, resources: [{ ...resource, instanceId: null }] },
      { ...workspace, resources: [{ ...resource, environmentId: 'local' as const }] },
      { ...workspace, resources: [{ ...resource, appProjectId: undefined }] },
    ])
      expect(researchDraftEligible(current, target)).toBe(false);
    expect(researchDraftEligible(workspace, null)).toBe(false);
    expect(researchDraftEligible(workspace, { kind: 'terminal', resourceId: 'page' })).toBe(false);
    const mota: ManagedApp['profile'] = { projectKind: 'mota-web', profileVersion: 1, source: { sourceSha256: 'a'.repeat(64), files: [] } };
    const edu: ManagedApp['profile'] = {
      projectKind: 'edu-web',
      profileVersion: 1,
      source: { repository: { commit: 'a'.repeat(40), dirty: false }, sourceSha256: 'a'.repeat(64), files: [] },
    };
    for (const profile of [mota, edu]) expect(researchDraftEligible({ ...workspace, managedApp: { ...app, profile } }, target)).toBe(false);
  });

  it('requires the frozen version to bind the same App, including when rerunning history', () => {
    expect(researchVersionEligible(workspace, version)).toBe(true);
    expect(researchVersionEligible(workspace, undefined)).toBe(false);
    expect(researchVersionEligible(workspace, { ...version, appTarget: null })).toBe(false);
    expect(researchVersionEligible(workspace, { ...version, appTarget: { ...version.appTarget!, projectId: 'old-project' } })).toBe(false);
    expect(researchVersionEligible(workspace, { ...version, workspaceId: 'other-space' })).toBe(false);
    expect(researchVersionEligible(workspace, { ...version, targetRef: { kind: 'web', resourceId: 'old-page' } })).toBe(false);
  });

  it('does not infer consent from eligibility and invalidates an in-flight opt-in on selection or cancellation', () => {
    const current = { context: 'space/session/version/target', revision: 3 };
    const requested = { ...current, enabled: true };
    expect(researchSubmissionEnabled({ ...current, enabled: false }, current, true, true)).toBe(false);
    expect(researchSubmissionEnabled(requested, current, true, true)).toBe(true);
    expect(researchSubmissionEnabled(requested, { ...current, context: 'another-session' }, true, true)).toBe(false);
    expect(researchSubmissionEnabled(requested, { ...current, context: 'another-version' }, true, true)).toBe(false);
    expect(researchSubmissionEnabled(requested, { ...current, revision: 4 }, true, true)).toBe(false);
    expect(researchSubmissionEnabled(requested, current, false, true)).toBe(false);
    expect(researchSubmissionEnabled(requested, current, true, false)).toBe(false);
  });

  it.each([false, true])('gates delayed confirmation against synchronous navigation before DOM hiding (navigate=%s)', async (navigate) => {
    const snapshot: WorkbenchSnapshot = {
      appInstanceId: 'research-navigation-test',
      activeWorkspaceId: 'space',
      seq: 1,
      storageError: null,
      notifications: [],
      notificationReadReceipts: [],
      environments: [],
      workspaces: [
        {
          ...workspace,
          name: 'Journal',
          revision: 1,
          tabs: [],
          layout: { kind: 'pane', paneId: 'pane', tabId: null },
          activePaneId: 'pane',
          sessions: [],
          runs: [],
          fileHints: [],
          observations: [],
          theme: 'light',
        },
      ],
    };
    workspaceStore.set(() => ({ snapshot, selectedId: 'space', error: null }));
    let releaseConfirmation!: (value: WorkbenchResult) => void;
    let releaseNavigation!: (value: WorkbenchResult) => void;
    let enteredConfirmation!: () => void;
    const confirmation = new Promise<WorkbenchResult>((resolve) => {
      releaseConfirmation = resolve;
    });
    const navigationReceipt = new Promise<WorkbenchResult>((resolve) => {
      releaseNavigation = resolve;
    });
    const confirmationEntered = new Promise<void>((resolve) => {
      enteredConfirmation = resolve;
    });
    const invoke = vi.fn((command: { type: string; webResearch?: boolean }): Promise<WorkbenchResult> => {
      if (command.type === 'confirmTask') {
        enteredConfirmation();
        return confirmation;
      }
      if (command.type === 'activateTab') return navigationReceipt;
      return Promise.resolve({ ok: true, snapshot });
    });
    vi.stubGlobal('window', { studio: { workbench: { command: invoke } } });
    const current = { context: 'space/session/version/target', revision: 3 };
    const requested = { ...current, enabled: true };
    const oldDomStillVisible = true;
    const token = beginNavigation();
    // Use the real metadata queue: activateTab cannot publish its new layout until confirmTask settles.
    const sending = (async () => {
      const result = await workspaceCommand('space', { type: 'confirmTask', sessionId: 'session', goal: 'Research', targetRef: target });
      if (!result?.ok) return;
      const allowed = researchSubmissionEnabled(requested, current, oldDomStillVisible, isCurrentNavigation(token));
      if (!allowed) return;
      await workspaceCommand('space', { type: 'startRun', sessionId: 'session', taskVersionId: 'version', webResearch: allowed });
    })();
    await confirmationEntered;
    const navigating = navigate ? workspaceCommand('space', { type: 'activateTab', tabId: 'other-tab' }) : null;
    expect(isCurrentNavigation(token)).toBe(!navigate);
    expect(invoke.mock.calls.map(([command]) => command.type)).toEqual(['confirmTask']);
    releaseConfirmation({ ok: true, snapshot });
    await sending;
    expect(oldDomStillVisible).toBe(true);
    expect(invoke.mock.calls.filter(([command]) => command.type === 'startRun')).toHaveLength(navigate ? 0 : 1);
    if (!navigate) expect(invoke.mock.calls.find(([command]) => command.type === 'startRun')?.[0].webResearch).toBe(true);
    releaseNavigation({ ok: true, snapshot });
    await navigating;
  });
});

describe('research source presentation', () => {
  it('keeps a search candidate separate from a read capture and requires a matching hash for inclusion', () => {
    const read = researchSummaryPresentation(run)!;
    expect(read.searches[0]!.candidateUrls).toEqual(['https://example.org/candidate']);
    expect(read.sources).toHaveLength(1);
    expect(read.sources[0]!.url).toBe(capture.url);
    expect(read.includedCount).toBe(0);
    expect(read.sources[0]!.included).toBe(false);
    const inclusion = { captureId: capture.captureId, contentSha256: capture.contentSha256, includedAt: capture.capturedAt };
    const included = researchSummaryPresentation({ ...run, researchSummary: { ...run.researchSummary!, inclusions: [inclusion] } })!;
    expect(included.includedCount).toBe(1);
    const wrong = researchSummaryPresentation({
      ...run,
      researchSummary: { ...run.researchSummary!, inclusions: [{ ...inclusion, contentSha256: 'c'.repeat(64) }] },
    })!;
    expect(wrong.includedCount).toBe(0);
    expect(wrong.incomplete).toBe(true);
  });

  it('does not show another run summary or stale native turn as this run evidence', () => {
    const foreign = researchSummaryPresentation({
      ...run,
      researchSummary: { ...run.researchSummary!, grant: { ...run.researchSummary!.grant, runId: 'other' } },
    })!;
    expect(foreign.sources).toEqual([]);
    expect(foreign.incomplete).toBe(true);
    for (const executionBinding of [{ generation: 'other', turnId: 'turn' }, { generation: 'generation', turnId: 'old' }, null]) {
      const stale = researchSummaryPresentation({ ...run, executionBinding })!;
      expect(stale.searches).toEqual([]);
      expect(stale.incomplete).toBe(true);
    }
  });

  it('retains native audit loss and capture truncation without inventing success', () => {
    for (const search of [
      { ...run.conversation!.nativeSearches![0]!, schemaUnsupported: true },
      { ...run.conversation!.nativeSearches![0]!, truncated: true },
      { ...run.conversation!.nativeSearches![0]!, status: 'unknown' as const },
    ])
      expect(researchSummaryPresentation({ ...run, conversation: { ...run.conversation!, nativeSearches: [search] } })?.incomplete).toBe(
        true,
      );
    expect(
      researchSummaryPresentation({ ...run, conversation: { ...run.conversation!, nativeSearches: [], nativeSearchesTruncated: true } })
        ?.incomplete,
    ).toBe(true);
    const truncated = researchSummaryPresentation({
      ...run,
      researchSummary: { ...run.researchSummary!, captures: [{ ...capture, truncated: true }] },
    })!;
    expect(truncated.sources[0]!.truncated).toBe(true);
    expect(truncated.includedCount).toBe(0);
  });

  it('renders source content as text and labels every evidence level without exposing internal IDs', () => {
    vi.stubGlobal('React', React);
    const sourceRun = {
      ...run,
      researchSummary: { ...run.researchSummary!, captures: [{ ...capture, title: '<img src=x onerror=alert(1)>', truncated: true }] },
    };
    const html = renderToStaticMarkup(React.createElement(ResearchSources, { run: sourceRun }));
    expect(html).toContain('候选：https://example.org/candidate');
    expect(html).toContain('已读取，未纳入');
    expect(html).toContain('正文已截断');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('readerResourceId');
    expect(html).not.toContain(capture.contentSha256);
    expect(
      renderToStaticMarkup(React.createElement(ResearchSources, { run: { ...run, researchSummary: undefined, conversation: null } })),
    ).toBe('');
  });
});
