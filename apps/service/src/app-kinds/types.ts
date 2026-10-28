import type { AppProfile } from '@wsl/protocol';

/**
 * 受管 App 类型契约。AppService 只拥有实例生命周期、端口与清理事实；
 * 各类型在这里声明差异，AppService 不按 projectKind 分支。
 */

export type SourceFile = { path: string; base64: string };

/** 固定来源的源码身份：启动前导出核验、guest 回报源码散列、导出时重算。 */
export interface PinnedSource<P extends AppProfile> {
  /** 新建实例时绑定的来源散列。 */
  initialSha256(profile: P): string;
  /** 核验源码并返回其散列；importing 为首次导入，要求与来源逐项一致。 */
  verify(files: readonly SourceFile[], profile: P, importing: boolean): string;
}

/** 尚未对该类型开放的能力；值为拒绝原因，缺省即开放。 */
export type UnavailableCapabilities = Partial<Record<'agent' | 'sourceSnapshot' | 'task', string>>;

export interface ManagedAppKind<P extends AppProfile = AppProfile> {
  readonly projectKind: P['projectKind'];
  /** /api/health 必须回报的模板身份。 */
  readonly health: { readonly templateId: string; readonly templateVersions: readonly [string, ...string[]] };
  /** null 表示不绑定来源散列。 */
  readonly pinnedSource: PinnedSource<P> | null;
  /** 端口发布/撤销意图先持久化，中断后按持久化事实核对并接管实例；需要 pinnedSource。 */
  readonly recoversOwnedInstance: boolean;
  /** 启动前向 guest 导入受信依赖归档。 */
  readonly installsDependencyArchive: boolean;
  readonly unavailable: UnavailableCapabilities;
}
