import type { WorkbenchTab, EnvironmentDescription, WorkspaceSnapshot } from '@wsl/protocol';
import { createStore } from '../lib/store';
import { occlusion } from './occlusion';
import { shellActions } from './shell';
import { workspaceStore } from './workspace';
export type Editor = {
  kind: 'workspace' | 'rename-workspace' | 'tab' | 'rename-tab' | 'group';
  tabId?: string;
  tabKind?: 'web' | 'terminal' | 'session';
  workspaceId?: string;
};
export const spaceUiStore = createStore<{
  appEditor: { workspace: WorkspaceSnapshot; overlayId: string } | null;
  appWorkspaceId: string | null;
  resourcesWorkspaceId: string | null;
  url: string;
  switcher: boolean;
  editor: Editor | null;
  name: string;
  kind: WorkbenchTab['targetRef']['kind'];
  tabMenu: string | null;
  environments: EnvironmentDescription[];
  environmentId: string;
  environmentError: string | null;
  loadingEnvironments: boolean;
}>({
  appEditor: null,
  appWorkspaceId: null,
  resourcesWorkspaceId: null,
  url: '',
  switcher: false,
  editor: null,
  name: '',
  kind: 'web',
  tabMenu: null,
  environments: [],
  environmentId: '',
  environmentError: null,
  loadingEnvironments: false,
});
const previous = new Map<string, HTMLElement | null>();
async function acquire(source: string) {
  previous.set(
    source,
    source === 'editor'
      ? ((occlusion.store.get()['switcher'] ? previous.get('switcher') : null) ??
          (occlusion.store.get()['tab-menu'] ? previous.get('tab-menu') : null) ??
          (document.activeElement instanceof HTMLElement ? document.activeElement : null))
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null,
  );
  return occlusion.open(source);
}
function release(source: string) {
  occlusion.close(source);
  const element = previous.get(source);
  previous.delete(source);
  requestAnimationFrame(() => {
    if (element?.isConnected && !element.closest('dialog:not([open])')) element.focus();
    else document.querySelector<HTMLButtonElement>('[aria-label="切换空间"]')?.focus();
  });
}

async function loadEnvironments(editor: Editor) {
  spaceUiStore.set((s) => (s.editor === editor ? { ...s, loadingEnvironments: true, environmentError: null } : s));
  try {
    const environments = await window.studio.workbench.environments();
    spaceUiStore.set((s) => (s.editor === editor ? { ...s, environments, loadingEnvironments: false } : s));
  } catch (error) {
    spaceUiStore.set((s) =>
      s.editor === editor ? { ...s, environments: [], environmentError: (error as Error).message, loadingEnvironments: false } : s,
    );
  }
}

let openingAppEditor = false;
export const spaceActions = {
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
  async openSwitcher() {
    if (await acquire('switcher')) spaceUiStore.set((s) => ({ ...s, switcher: true }));
  },
  closeSwitcher() {
    spaceUiStore.set((s) => ({ ...s, switcher: false }));
    release('switcher');
  },
  async openEditor(editor: Editor, name = '') {
    editor = { ...editor, workspaceId: workspaceStore.get().selectedId ?? undefined };
    if (!(await acquire('editor'))) return;
    spaceUiStore.set((s) => ({
      ...s,
      editor,
      name,
      kind: editor.tabKind ?? 'web',
      url: '',
      switcher: false,
      tabMenu: null,
      environmentId: '',
      environmentError: null,
      loadingEnvironments: editor.kind === 'tab',
    }));
    if (editor.kind === 'tab') void loadEnvironments(editor);
    occlusion.close('switcher');
    occlusion.close('tab-menu');
    previous.delete('switcher');
    previous.delete('tab-menu');
  },
  closeEditor() {
    document.querySelector<HTMLDialogElement>('dialog.workspace-editor:not(.managed-app-dialog)')?.close();
    spaceUiStore.set((s) => ({ ...s, editor: null }));
    release('editor');
  },
  async openTabMenu(tabMenu: string) {
    if (await acquire('tab-menu')) spaceUiStore.set((s) => ({ ...s, tabMenu }));
  },
  closeTabMenu() {
    spaceUiStore.set((s) => ({ ...s, tabMenu: null }));
    release('tab-menu');
  },
};
