/**
 * 资源、联系人、动态与会话消息的演示数据。界面上都带“演示”标识，
 * 本轮不接人际消息、资源授权后台与订阅，相关动作在界面上禁用并说明原因。
 */

export interface DemoMessage {
  id: string;
  author: 'user' | 'agent';
  text: string;
  meta: string;
}

export const DEMO_SPACE_MESSAGES: readonly DemoMessage[] = [
  { id: 'm1', author: 'user', text: '看看任务列表的截止日期为什么都显示“未设置”。', meta: '演示 · 09:41' },
  {
    id: 'm2',
    author: 'agent',
    text: '这里是演示消息，不是 Codex 的回复。真实会话要等 Codex CLI 通路接入（T02）后才会出现。',
    meta: '演示',
  },
];

export interface DemoContact {
  id: string;
  name: string;
  initial: string;
  preview: string;
  time: string;
  kind: 'direct' | 'group';
}

export const DEMO_CONTACTS: readonly DemoContact[] = [
  { id: 'p1', name: '周宁', initial: '周', preview: '明天一起过一遍 C2？', time: '09:12', kind: 'direct' },
  { id: 'g1', name: '比赛小组 · 3 人', initial: '赛', preview: '视频脚本已更新', time: '昨天', kind: 'group' },
];

export interface DemoFeedItem {
  id: string;
  title: string;
  note: string;
  meta: string;
  pending: boolean;
}

export const DEMO_FEED: readonly DemoFeedItem[] = [
  {
    id: 'f1',
    title: '演示：C1 run 通过固定验收，等待审阅',
    note: '点开会定位到演示记录。只标记已读不算接受结果。',
    meta: '演示 · 待处理',
    pending: true,
  },
  { id: 'f2', title: '演示：C3 run 无法判断（工具故障）', note: '工具故障与业务验收失败分开显示。', meta: '演示 · 已读', pending: false },
];

export interface DemoResource {
  id: string;
  name: string;
  kind: '文档' | '网页' | 'SSH 位置' | '终端位置';
  group: string;
  linkedSpace: string | null;
  updated: string;
}

export const DEMO_RESOURCE_GROUPS = ['上线资料', '设计参考', '服务器'] as const;

export const DEMO_RESOURCES: readonly DemoResource[] = [
  { id: 'r1', name: '验收清单', kind: '文档', group: '上线资料', linkedSpace: 'TaskFlow 演示空间（副本）', updated: 'r12' },
  { id: 'r2', name: '发布检查表', kind: '文档', group: '上线资料', linkedSpace: null, updated: 'r3' },
  { id: 'r3', name: '预发环境', kind: 'SSH 位置', group: '服务器', linkedSpace: null, updated: '9 月' },
  { id: 'r4', name: '监控面板', kind: '网页', group: '上线资料', linkedSpace: null, updated: '9 月' },
  { id: 'r5', name: '交互设计规范 v0.2', kind: '文档', group: '设计参考', linkedSpace: null, updated: '10/6' },
];
