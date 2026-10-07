import type { IconName } from '../components/Icon';
import type { Route } from '../state/shell';

export const ROUTES: ReadonlyArray<{ route: Route; label: string; icon: IconName }> = [
  { route: 'home', label: '首页', icon: 'home' },
  { route: 'space', label: '空间', icon: 'space' },
  { route: 'resources', label: '资源', icon: 'folder' },
  { route: 'conversations', label: '会话', icon: 'chat' },
  { route: 'tasks', label: '任务', icon: 'task' },
];

export const ROUTE_TITLES: Record<Route, string> = {
  home: '首页',
  space: '空间',
  resources: '资源',
  conversations: '会话',
  tasks: '任务',
  settings: '应用设置',
};
