import type { WorkbenchTab, EnvironmentDescription } from '@wsl/protocol';
import { createStore } from '../lib/store';
import { occlusion } from './occlusion';
export type Editor = { kind: 'workspace' | 'rename-workspace' | 'tab' | 'rename-tab' | 'group'; tabId?: string };
export const spaceUiStore = createStore<{
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

export const spaceActions = {
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
    if (!(await acquire('editor'))) return;
    spaceUiStore.set((s) => ({
      ...s,
      editor,
      name,
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
    document.querySelector<HTMLDialogElement>('dialog.workspace-editor')?.close();
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
