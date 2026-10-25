import { z } from 'zod';

/**
 * Main 原生菜单（OPS-1 S5，`window.studio.shell.showMenu`）。
 * renderer 只提交固定的菜单类型与身份上下文；菜单文字、条目与可用状态由 Main 按自己的快照构建，
 * 结果是固定枚举内的菜单项与 Main 冻结的目标，取消为 null。菜单本身不执行业务。
 */

const Id = z.string().min(1).max(200);
const Coordinate = z.number().min(-100_000).max(100_000);
const Extent = z.number().min(0).max(100_000);

/** 菜单锚点（窗口内容区坐标，与 renderer 的 CSS 像素一致）：鼠标打开时为指针位置（宽高为 0），键盘打开时为焦点元素矩形。 */
export const MenuAnchorSchema = z.object({ x: Coordinate, y: Coordinate, width: Extent, height: Extent }).strict();
export type MenuAnchor = z.infer<typeof MenuAnchorSchema>;

export const NativeMenuIdSchema = z.enum(['tab', 'pane', 'run-records', 'web-more', 'capture-receiver', 'new-tab']);
export type NativeMenuId = z.infer<typeof NativeMenuIdSchema>;

/** 每类菜单的菜单项身份（固定枚举）。 */
export const TabMenuItemSchema = z.enum([
  'pin',
  'unpin',
  'rename',
  'set-group',
  'ungroup',
  'move-up',
  'move-down',
  'open-right',
  'open-below',
  'close-tab',
]);
export const PaneMenuItemSchema = z.enum(['split-right', 'split-below', 'equalize', 'close-pane']);
export const RunRecordsMenuItemSchema = z.enum(['log', 'diff', 'report']);
export const WebMoreMenuItemSchema = z.enum(['manage-app', 'bookmark', 'snapshot', 'show-resources']);
/** 采集接收者：`session` 把 target.sessionId 设为之后采集的接收者；`new-session` 新建会话作为接收者；`open-receiver` 打开当前接收会话。都不开始采集。 */
export const CaptureReceiverMenuItemSchema = z.enum(['session', 'new-session', 'open-receiver']);
export const NewTabMenuItemSchema = z.enum(['web', 'terminal', 'session', 'file', 'ssh']);

const context = <S extends z.ZodRawShape>(shape: S) =>
  z.object({ workspaceId: Id, ...shape, anchor: MenuAnchorSchema.optional() }).strict();
const request = <M extends NativeMenuId, C extends z.ZodTypeAny>(menuId: M, schema: C) =>
  z.object({ menuId: z.literal(menuId), context: schema }).strict();

/** `shell:show-menu` 请求：菜单类型 + 严格的身份上下文（每类菜单各自的 schema）。 */
export const ShowMenuRequestSchema = z.discriminatedUnion('menuId', [
  request('tab', context({ tabId: Id })),
  request('pane', context({ paneId: Id })),
  /** current：会话当前显示的运行记录视图（展示提示，只用于在菜单里标出当前项，不参与授权）。 */
  request('run-records', context({ sessionId: Id, current: RunRecordsMenuItemSchema.optional() })),
  request('web-more', context({ resourceId: Id })),
  /** receiverSessionId：此网页当前显示的接收会话（renderer 展示状态，OPS-1 S1）；为 null（将自动新建）时菜单没有「打开接收会话」。 */
  request('capture-receiver', context({ resourceId: Id, receiverSessionId: Id.nullable() })),
  request('new-tab', context({})),
]);
export type ShowMenuRequest = z.infer<typeof ShowMenuRequestSchema>;
export type NativeMenuContext<M extends NativeMenuId> = Extract<ShowMenuRequest, { menuId: M }>['context'];

const Revision = z.number().int().nonnegative();
const choice = <M extends NativeMenuId, I extends z.ZodTypeAny, T extends z.ZodTypeAny>(menuId: M, itemId: I, target: T) =>
  z.object({ menuId: z.literal(menuId), itemId, target }).strict();

/**
 * 菜单选择。target 是 Main 构建菜单时冻结的身份：迟到的选择按它执行，不转向当前活动空间；
 * revision 是构建时的空间版本，依赖布局或排序的动作据此触发版本冲突。
 */
export const NativeMenuChoiceSchema = z.discriminatedUnion('menuId', [
  choice('tab', TabMenuItemSchema, z.object({ workspaceId: Id, tabId: Id, paneId: Id, revision: Revision }).strict()),
  choice('pane', PaneMenuItemSchema, z.object({ workspaceId: Id, paneId: Id, revision: Revision }).strict()),
  choice('run-records', RunRecordsMenuItemSchema, z.object({ workspaceId: Id, sessionId: Id }).strict()),
  choice('web-more', WebMoreMenuItemSchema, z.object({ workspaceId: Id, resourceId: Id }).strict()),
  choice(
    'capture-receiver',
    CaptureReceiverMenuItemSchema,
    z.object({ workspaceId: Id, resourceId: Id, sessionId: Id.nullable() }).strict(),
  ),
  choice('new-tab', NewTabMenuItemSchema, z.object({ workspaceId: Id }).strict()),
]);
export type NativeMenuChoice = z.infer<typeof NativeMenuChoiceSchema>;
export const ShowMenuResultSchema = NativeMenuChoiceSchema.nullable();
