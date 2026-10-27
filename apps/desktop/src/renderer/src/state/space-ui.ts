import { defaultEnvironment, readEnvironmentPreference } from './default-environment';
import type { WorkbenchTab, EnvironmentDescription, WorkspaceSnapshot, NativeBrowserFocus } from '@wsl/protocol';
import { reportError } from './errors';
import { createStore } from '../lib/store';
import { occlusion } from './occlusion';
import { shellActions } from './shell';
import { beginNavigation, isCurrentNavigation, workspaceStore } from './workspace';
export type Editor = {
  kind: 'workspace' | 'rename-workspace' | 'tab' | 'group';
  tabId?: string;
  tabKind?: WorkbenchTab['targetRef']['kind'];
  workspaceId?: string;
};
export const spaceUiStore = createStore<{
  renaming: { workspaceId: string; tabId: string } | null;
  appEditor: { workspace: WorkspaceSnapshot; overlayId: string } | null;
  appWorkspaceId: string | null;
  resourcesWorkspaceId: string | null;
  url: string;
  switcher: boolean;
  editor: Editor | null;
  name: string;
  kind: WorkbenchTab['targetRef']['kind'];
  environments: EnvironmentDescription[];
  environmentId: string;
  environmentError: string | null;
  loadingEnvironments: boolean;
}>({
  renaming: null,
  appEditor: null,
  appWorkspaceId: null,
  resourcesWorkspaceId: null,
  url: '',
  switcher: false,
  editor: null,
  name: '',
  kind: 'web',
  environments: [],
  environmentId: '',
  environmentError: null,
  loadingEnvironments: false,
});
let openingSwitcher = false;
const previousNative = new Map<string, NativeBrowserFocus | null>();
let restoring = 0;
const previous = new Map<string, HTMLElement | null>();
async function acquire(source: string) {
  previous.set(
    source,
    source === 'editor'
      ? ((occlusion.store.get()['switcher'] ? previous.get('switcher') : null) ??
          (document.activeElement instanceof HTMLElement ? document.activeElement : null))
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null,
  );
  return occlusion.open(source);
}
function release(source: string, restoreFocus = true) {
  occlusion.close(source);
  const element = previous.get(source);
  const native = previousNative.get(source);
  previous.delete(source);
  previousNative.delete(source);
  const generation = ++restoring;
  if (!restoreFocus) return;
  if (native) {
    // Browser bounds become visible after releasing the final overlay barrier.
    const restore = async () => {
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (generation !== restoring || occlusion.blocked()) return;
        if (await window.studio.shell.restoreBrowserFocus(native)) return;
      }
    };
    void restore().catch((error: unknown) => reportError('恢复网页焦点', error));
    return;
  }
  requestAnimationFrame(() => {
    if (generation !== restoring) return;
    // Closing and restoring span a frame; keep focus acquired by a newer interaction or overlay.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && active.isConnected && !active.closest('dialog:not([open])')) return;
    if (element?.isConnected && !element.closest('dialog:not([open])')) element.focus();
    else document.querySelector<HTMLButtonElement>('[aria-label="切换空间"]')?.focus();
  });
}

async function loadEnvironments(editor: Editor) {
  spaceUiStore.set((s) => (s.editor === editor ? { ...s, loadingEnvironments: true, environmentError: null } : s));
  try {
    const environments = await window.studio.workbench.environments();
    spaceUiStore.set((s) =>
      s.editor === editor
        ? {
            ...s,
            environments,
            loadingEnvironments: false,
            environmentId:
              defaultEnvironment(environments, s.kind, readEnvironmentPreference(localStorage, editor.workspaceId ?? '', s.kind))
                ?.environmentId ?? '',
          }
        : s,
    );
  } catch (error) {
    spaceUiStore.set((s) =>
      s.editor === editor ? { ...s, environments: [], environmentError: (error as Error).message, loadingEnvironments: false } : s,
    );
  }
}

let openingAppEditor = false;
export const spaceActions = {
  renameTab(workspaceId: string, tabId: string) {
    spaceUiStore.set((s) => ({ ...s, renaming: { workspaceId, tabId } }));
  },
  closeRename() {
    spaceUiStore.set((s) => ({ ...s, renaming: null }));
  },
  async openAppEditor(workspace: WorkspaceSnapshot) {
    if (openingAppEditor || spaceUiStore.get().appEditor) return;
    openingAppEditor = true;
    const target = structuredClone(workspace);
    const overlayId = `app-editor-${crypto.randomUUID()}`;
    try {
      if (await occlusion.open(overlayId)) spaceUiStore.set((s) => ({ ...s, appEditor: { workspace: target, overlayId } }));
    } finally {
      openingAppEditor = false;
    }
  },
  closeAppEditor(overlayId: string) {
    spaceUiStore.set((s) => (s.appEditor?.overlayId === overlayId ? { ...s, appEditor: null } : s));
    occlusion.close(overlayId);
  },

  async showResources(workspaceId: string) {
    await shellActions.setPeek(true);
    spaceUiStore.set((s) => ({ ...s, resourcesWorkspaceId: workspaceId }));
    requestAnimationFrame(() => document.getElementById('space-resources-summary')?.focus());
  },
  async openApp(workspaceId: string) {
    if (await acquire('app-dialog')) spaceUiStore.set((s) => ({ ...s, appWorkspaceId: workspaceId }));
  },
  closeApp() {
    document.querySelector<HTMLDialogElement>('dialog.managed-app-dialog')?.close();
    spaceUiStore.set((s) => ({ ...s, appWorkspaceId: null }));
    release('app-dialog');
  },
  reloadEnvironments() {
    const state = spaceUiStore.get();
    if (state.editor?.kind === 'tab' && !state.loadingEnvironments) void loadEnvironments(state.editor);
  },
  async openSwitcher(native?: NativeBrowserFocus | null) {
    if (openingSwitcher || spaceUiStore.get().switcher) return;
    openingSwitcher = true;
    try {
      restoring++;
      previousNative.set('switcher', native === undefined ? await window.studio.shell.nativeFocus() : native);
      if (!(await acquire('switcher'))) return;
      if (!(await window.studio.shell.focusWorkbench())) {
        occlusion.close('switcher');
        return;
      }
      spaceUiStore.set((s) => ({ ...s, switcher: true }));
    } finally {
      openingSwitcher = false;
    }
  },
  closeSwitcher(restoreFocus = true) {
    spaceUiStore.set((s) => ({ ...s, switcher: false }));
    release('switcher', restoreFocus);
  },
  async openEditor(editor: Editor, name = '') {
    editor = { ...editor, workspaceId: workspaceStore.get().selectedId ?? undefined };
    const navigation = beginNavigation();
    const native = previousNative.get('switcher');
    if (!(await acquire('editor'))) return;
    if (!isCurrentNavigation(navigation) || (workspaceStore.get().selectedId ?? undefined) !== editor.workspaceId) {
      occlusion.close('editor');
      return;
    }
    previousNative.set('editor', native ?? null);
    spaceUiStore.set((s) => ({
      ...s,
      editor,
      name,
      kind: editor.tabKind ?? 'web',
      url: '',
      switcher: false,
      environmentId: '',
      environmentError: null,
      loadingEnvironments: editor.kind === 'tab',
    }));
    if (editor.kind === 'tab') void loadEnvironments(editor);
    occlusion.close('switcher');
    previous.delete('switcher');
    previousNative.delete('switcher');
  },
  closeEditor() {
    document.querySelector<HTMLDialogElement>('dialog.workspace-editor:not(.managed-app-dialog)')?.close();
    spaceUiStore.set((s) => ({ ...s, editor: null }));
    release('editor');
  },
};
