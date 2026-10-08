import { z } from 'zod';

/** Browser 区视图在窗口内容区中的位置，单位为 CSS 像素（DIP）。 */
export const PreviewBoundsSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(0),
  height: z.number().int().min(0),
});
export type PreviewBounds = z.infer<typeof PreviewBoundsSchema>;

/**
 * renderer 申报的布局。visible=false 时主进程隐藏原生视图，
 * 例如切到日志 Tab、离开空间页，或有浮层遮挡页面区域。
 */
export const PreviewLayoutSchema = z.object({
  bounds: PreviewBoundsSchema,
  visible: z.boolean(),
});
export type PreviewLayout = z.infer<typeof PreviewLayoutSchema>;

export const PreviewNavigateRequestSchema = z.object({
  url: z.string().min(1).max(2048),
});
export type PreviewNavigateRequest = z.infer<typeof PreviewNavigateRequestSchema>;

/** CDP 通道状态。detached 时暂停页面自动操作，并给出原因。 */
export const CdpStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('attached') }),
  z.object({ state: z.literal('detached'), reason: z.string() }),
  z.object({ state: z.literal('idle') }),
]);
export type CdpState = z.infer<typeof CdpStateSchema>;

/**
 * 页面身份：同一个 webContents 内，每次主框架导航（含同文档导航）都会让
 * documentGeneration 加一。现场引用以 (webContentsId, documentGeneration) 判断是否仍然有效。
 */
export const PageIdentitySchema = z.object({
  webContentsId: z.number().int(),
  documentGeneration: z.number().int().min(0),
  url: z.string(),
  title: z.string(),
  partition: z.string(),
});
export type PageIdentity = z.infer<typeof PageIdentitySchema>;

export const PageConsoleEntrySchema = z.object({
  level: z.enum(['error', 'warning']),
  message: z.string(),
  source: z.string(),
  line: z.number().int(),
});
export type PageConsoleEntry = z.infer<typeof PageConsoleEntrySchema>;

export const PreviewStateSchema = z.object({
  page: PageIdentitySchema,
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  picking: z.boolean(),
  cdp: CdpStateSchema,
  /** 当前文档代次内收集到的错误与警告数量。 */
  consoleIssueCount: z.number().int().min(0),
  loadError: z.object({ code: z.number().int(), description: z.string(), url: z.string() }).nullable(),
  /** 最近一次被导航策略拦截的地址。 */
  blockedNavigation: z.string().nullable(),
  /** 最近一次点选失败的原因；成功采集后清空。 */
  pickError: z.string().nullable(),
});
export type PreviewState = z.infer<typeof PreviewStateSchema>;

export const ElementRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const ElementSummarySchema = z.object({
  tagName: z.string(),
  id: z.string().nullable(),
  classes: z.array(z.string()),
  role: z.string().nullable(),
  ariaLabel: z.string().nullable(),
  testId: z.string().nullable(),
  /** 元素可见文本，已截断。 */
  text: z.string(),
  /** 由主进程从 DOM 结构推导的 CSS 路径，只用于展示和定位提示。 */
  selector: z.string(),
  /** 来自 CDP 盒模型，相对于页面视口；元素没有布局（例如 display:none）时为 null。 */
  rect: ElementRectSchema.nullable(),
});
export type ElementSummary = z.infer<typeof ElementSummarySchema>;

/**
 * 一次点选采集的现场。截图与元素信息都来自 page 所指的同一个 webContents。
 * 截图以 data URL 形式在内存中传递，本轮不落盘。
 */
export const PageCaptureSchema = z.object({
  captureId: z.string(),
  capturedAt: z.string(),
  page: PageIdentitySchema,
  element: ElementSummarySchema,
  screenshot: z.object({
    viewport: z.string().startsWith('data:image/png;base64,'),
    element: z.string().startsWith('data:image/png;base64,').nullable(),
  }),
  consoleIssues: z.array(PageConsoleEntrySchema),
});
export type PageCapture = z.infer<typeof PageCaptureSchema>;

export const PreviewFreezeResultSchema = z.object({
  dataUrl: z.string(),
});
export type PreviewFreezeResult = z.infer<typeof PreviewFreezeResultSchema>;
