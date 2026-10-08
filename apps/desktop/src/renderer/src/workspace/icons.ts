import type { WorkbenchTab } from '@wsl/protocol';
import type { IconName } from '../components/Icon';
export const resourceIcons: Record<WorkbenchTab['targetRef']['kind'], IconName> = {
  web: 'globe',
  terminal: 'terminal',
  session: 'chat',
  ssh: 'terminal',
  file: 'doc',
};
