import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  HarnessProfilesSnapshotSchema,
  PROFILE_CREATABLE_HARNESSES,
  builtinProfileId,
  profileDirOf,
  type HarnessProfile,
  type HarnessProfileId,
  type HarnessProfilesSnapshot,
  type HarnessSelection,
  type ProfileCheckResult,
  type ProfileDir,
  type HarnessAvailability,
  type HarnessRef,
  type ChatStatus,
  type TurnHarness,
  harnessRefOf,
} from '@wsl/protocol';

/**
 * 内置 Profile 对应的 Harness；与 service 的注册表一致（W4-2、W4-3）。
 * 名称与接入方式只在执行服务尚未报告该 Harness 时用作出处，此时版本记为 null（未实测）。
 */
const BUILTIN_HARNESSES = [
  { harnessId: 'codex', label: 'sbx 默认', displayName: 'Codex CLI', adapter: 'native' },
  { harnessId: 'claude-code', label: '默认', displayName: 'Claude Code', adapter: 'acp' },
] as const;
const FileSchema = z
  .object({ schemaVersion: z.literal(1) })
  .extend(HarnessProfilesSnapshotSchema.shape)
  .strict();

/**
 * Harness Profile 的唯一写入者（W4-5：userData 下独立文件，Main 单点写入）。
 *
 * 只存配置目录引用、标签与最近一次自检的解析结果，不存任何凭据或 CLI 原始输出。
 * 写入串行化并以临时文件原子替换；文件版本较新或内容无效时报错并保留原文件，不覆盖为默认值。
 */
export class HarnessProfileStore {
  private snapshot: HarnessProfilesSnapshot | null = null;
  private loadError: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(snapshot: HarnessProfilesSnapshot) => void>();

  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  onChange(listener: (snapshot: HarnessProfilesSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async load(): Promise<HarnessProfilesSnapshot> {
    return this.serialize(async () => this.current());
  }

  get(): HarnessProfilesSnapshot {
    if (!this.snapshot) throw new Error(this.loadError ?? 'Harness Profile 尚未加载');
    return structuredClone(this.snapshot);
  }

  find(profileId: HarnessProfileId): HarnessProfile | null {
    return this.get().profiles.find((profile) => profile.profileId === profileId) ?? null;
  }

  create(label: string): Promise<HarnessProfilesSnapshot> {
    return this.mutate((snapshot) => {
      const harnessId = PROFILE_CREATABLE_HARNESSES[0];
      const profileId = randomUUID();
      const configDir = profileDirOf(harnessId, profileId);
      if (!configDir) throw new Error(`${harnessId} 不支持新建 Profile`);
      snapshot.profiles.push({
        profileId,
        harnessId,
        environmentId: 'sandbox',
        configDir,
        label: label.trim(),
        builtin: false,
        createdAt: this.now().toISOString(),
        check: null,
      });
    });
  }

  remove(profileId: HarnessProfileId): Promise<HarnessProfilesSnapshot> {
    return this.mutate((snapshot) => {
      const profile = snapshot.profiles.find((item) => item.profileId === profileId);
      if (!profile) throw new Error('not_found: Profile 不存在');
      if (profile.builtin) throw new Error('invalid: 内置 Profile 不能删除');
      snapshot.profiles = snapshot.profiles.filter((item) => item.profileId !== profileId);
      // 删除默认 Profile 后回到 Codex 的内置 Profile；历史执行记录保留原 profileId 作为出处。
      if (snapshot.defaultSelection.profileId === profileId)
        snapshot.defaultSelection = { harnessId: 'codex', profileId: builtinProfileId('codex') };
    });
  }

  setDefault(selection: HarnessSelection): Promise<HarnessProfilesSnapshot> {
    return this.mutate((snapshot) => {
      assertSelectable(snapshot, selection);
      snapshot.defaultSelection = selection;
    });
  }

  recordCheck(profileId: HarnessProfileId, result: ProfileCheckResult): Promise<HarnessProfilesSnapshot> {
    return this.mutate((snapshot) => {
      const profile = snapshot.profiles.find((item) => item.profileId === profileId);
      // 自检期间 Profile 被删除：结果作废，不复活已删除的记录。
      if (!profile) throw new Error('not_found: Profile 已删除');
      profile.check = { ...result, checkedAt: this.now().toISOString() };
    });
  }

  private mutate(change: (snapshot: HarnessProfilesSnapshot) => void): Promise<HarnessProfilesSnapshot> {
    return this.serialize(async () => {
      const next = structuredClone(await this.current());
      change(next);
      const validated = HarnessProfilesSnapshotSchema.parse(next);
      await mkdir(path.dirname(this.file), { recursive: true });
      const pending = this.file + '.pending';
      await writeFile(pending, JSON.stringify({ schemaVersion: 1, ...validated }), { mode: 0o600 });
      await rename(pending, this.file);
      this.snapshot = validated;
      for (const listener of this.listeners) listener(structuredClone(validated));
      return structuredClone(validated);
    });
  }

  private async current(): Promise<HarnessProfilesSnapshot> {
    if (this.snapshot) return this.snapshot;
    let contents: string | null = null;
    try {
      contents = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (contents === null) {
      this.snapshot = initialSnapshot(this.now());
      return this.snapshot;
    }
    try {
      const raw: unknown = JSON.parse(contents);
      const version = typeof raw === 'object' && raw !== null ? (raw as { schemaVersion?: unknown }).schemaVersion : undefined;
      if (typeof version === 'number' && version > 1) throw new Error(`Harness Profile 文件版本 ${version} 较新，已保留原文件`);
      const { schemaVersion: _version, ...stored } = FileSchema.parse(raw);
      this.snapshot = withBuiltins(stored, this.now());
      return this.snapshot;
    } catch (error) {
      // 不覆盖原文件；之后的读取与修改都报告同一原因。
      this.loadError = `Harness Profile 文件无法读取：${error instanceof Error ? error.message.slice(0, 300) : String(error)}`;
      throw new Error(this.loadError, { cause: error });
    }
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function initialSnapshot(now: Date): HarnessProfilesSnapshot {
  return withBuiltins({ profiles: [], defaultSelection: { harnessId: 'codex', profileId: builtinProfileId('codex') } }, now);
}

/** 内置 Profile 总是存在；旧文件缺少新的内置项时补上，不改动已有记录。 */
function withBuiltins(snapshot: HarnessProfilesSnapshot, now: Date): HarnessProfilesSnapshot {
  const profiles = [...snapshot.profiles];
  for (const { harnessId, label } of BUILTIN_HARNESSES) {
    const profileId = builtinProfileId(harnessId);
    if (!profiles.some((profile) => profile.profileId === profileId))
      profiles.push({
        profileId,
        harnessId,
        environmentId: 'sandbox',
        configDir: null,
        label,
        builtin: true,
        createdAt: now.toISOString(),
        check: null,
      });
  }
  const next = HarnessProfilesSnapshotSchema.parse({ ...snapshot, profiles });
  assertSelectable(next, next.defaultSelection);
  return next;
}

function assertSelectable(snapshot: HarnessProfilesSnapshot, selection: HarnessSelection) {
  const profile = snapshot.profiles.find((item) => item.profileId === selection.profileId);
  if (!profile) throw new Error('not_found: Profile 不存在');
  if (profile.harnessId !== selection.harnessId) throw new Error('invalid: Profile 不属于所选 Harness');
}

/** 执行服务提供给 Profile 协调器的两项能力。 */
export interface ProfileRuntime {
  harnesses(): HarnessAvailability[];
  checkProfile(harnessId: string, profileDir: ProfileDir | null): Promise<ProfileCheckResult>;
}

const LOGIN_TEXT: Record<ProfileCheckResult['login'], string> = {
  logged_in: '已登录',
  logged_out: '未登录',
  undetermined: '无法判断登录状态',
};

/**
 * Profile 的用例入口（W4a）：管理、无模型自检、按选择解析出冻结的出处与本轮参数。
 *
 * `resolve` 在 Main 的元数据队列内同步调用，只拒绝无效选择（Profile 已删除或不属于该 Harness）。
 * Harness 不可用与 Profile 未登录在 `prepare`（启动路径）上判断：执行照常创建，随后以明确原因记为失败，
 * 与“执行器不可用时记录失败运行”的既有约定一致，也不把 guest 自检放进元数据队列。
 * 认证或配额问题只报告，不换到其他 Profile（设计 §5）。
 */
export class HarnessProfileService {
  private readonly inFlight = new Map<HarnessProfileId, Promise<HarnessProfilesSnapshot>>();
  private initialCheck = false;

  constructor(
    readonly store: HarnessProfileStore,
    private readonly runtime: ProfileRuntime,
  ) {}

  /** 执行服务第一次可用时，为全部 Profile 各做一次自检；失败只记入各自的结果。 */
  onStatus(status: ChatStatus) {
    if (this.initialCheck || !status.available) return;
    this.initialCheck = true;
    for (const profile of this.store.get().profiles)
      void this.check(profile.profileId).catch((error: unknown) => console.error('Profile 自检失败', profile.profileId, error));
  }

  check(profileId: HarnessProfileId): Promise<HarnessProfilesSnapshot> {
    const running = this.inFlight.get(profileId);
    if (running) return running;
    const task = (async () => {
      const profile = this.store.find(profileId);
      if (!profile) throw new Error('not_found: Profile 不存在');
      let result: ProfileCheckResult;
      try {
        result = await this.runtime.checkProfile(profile.harnessId, profile.configDir);
      } catch (error) {
        result = {
          cliVersion: null,
          login: 'undetermined',
          reason: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        };
      }
      return this.store.recordCheck(profileId, result);
    })().finally(() => this.inFlight.delete(profileId));
    this.inFlight.set(profileId, task);
    return task;
  }

  /** 解析选择（空为全局默认）并给出冻结的出处；只拒绝已删除或不属于该 Harness 的 Profile。 */
  resolve(selection: HarnessSelection | null): { ref: HarnessRef; turn: TurnHarness } {
    const snapshot = this.store.get();
    const chosen = selection ?? snapshot.defaultSelection;
    const profile = snapshot.profiles.find((item) => item.profileId === chosen.profileId);
    if (!profile || profile.harnessId !== chosen.harnessId) throw new Error('conflict: 所选 Profile 已删除或不属于该 Harness，请重新选择');
    const availability = this.runtime.harnesses().find((item) => item.descriptor.harnessId === chosen.harnessId);
    const known = BUILTIN_HARNESSES.find((item) => item.harnessId === chosen.harnessId);
    if (!availability && !known) throw new Error(`conflict: 未知的 Harness：${chosen.harnessId}`);
    return {
      ref: availability
        ? harnessRefOf(availability.descriptor, profile.profileId)
        : {
            harnessId: known!.harnessId,
            displayName: known!.displayName,
            adapter: known!.adapter,
            version: null,
            profileId: profile.profileId,
          },
      turn: { harnessId: profile.harnessId, profileId: profile.profileId, profileDir: profile.configDir },
    };
  }

  /**
   * 启动路径：Harness 不可用时抛出其原因；Profile 未自检或上次不是已登录时先重新自检，结果仍不是已登录时抛出。
   * 调用方按“从未启动”把执行记为失败。执行服务尚未报告任何 Harness（例如未配置 sandbox）时不在这里判断，
   * 由发送沿用执行服务给出的原始原因失败。
   */
  async prepare(turn: TurnHarness): Promise<void> {
    const reported = this.runtime.harnesses();
    const availability = reported.find((item) => item.descriptor.harnessId === turn.harnessId);
    if (reported.length === 0) return;
    if (!availability) throw new Error(`执行服务未报告 ${turn.harnessId}`);
    if (!availability.available) throw new Error(`${availability.descriptor.displayName} 不可用：${availability.reason ?? '未知原因'}`);
    let profile = this.store.find(turn.profileId);
    // 未自检或上次不是已登录（用户可能刚在终端里登录）时重新自检一次，以最新结果判断。
    if (profile && profile.check?.login !== 'logged_in')
      profile = (await this.check(turn.profileId)).profiles.find((item) => item.profileId === turn.profileId) ?? null;
    if (!profile) throw new Error('所选 Profile 已删除');
    if (profile.check?.login !== 'logged_in')
      throw new Error(
        `Profile「${profile.label}」${LOGIN_TEXT[profile.check?.login ?? 'undetermined']}：${profile.check?.reason ?? '请登录后重新自检'}`,
      );
  }
}
