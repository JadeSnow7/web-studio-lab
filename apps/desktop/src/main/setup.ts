import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import {
  RuntimeConfigSchema,
  SetupSnapshotSchema,
  SetupSettingsSchema,
  type RuntimeConfig,
  type SetupSnapshot,
  type DependencyManifest,
} from '@wsl/protocol';

export class SetupError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface SetupAdapter {
  check(signal: AbortSignal): Promise<DependencyManifest>;
  installSbx(signal: AbortSignal): Promise<string>;
  sandboxExists(binary: string, name: string, signal: AbortSignal): Promise<boolean>;
  createSandbox(binary: string, name: string, manifest: DependencyManifest, signal: AbortSignal): Promise<void>;
  inspectSandbox(binary: string, name: string, manifest: DependencyManifest, signal: AbortSignal): Promise<void>;
  installTools(binary: string, name: string, manifest: DependencyManifest, signal: AbortSignal): Promise<void>;
  probe(binary: string, name: string, signal: AbortSignal): Promise<void>;
  modelConfigured(binary: string, signal: AbortSignal): Promise<boolean>;
  login(binary: string, provider: 'docker' | 'openai', signal: AbortSignal, operationId: string, resume?: boolean): Promise<void>;
}
/** Main is the only writer. Configuration changes are staged for the next app launch. */
export class SetupManager {
  private snapshot: SetupSnapshot;
  private operation: AbortController | null = null;
  private idle: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(snapshot: SetupSnapshot) => void>();
  private selectedLocalRoot: string | null = null;
  private readonly activeConfig: RuntimeConfig;
  private constructor(
    private readonly file: string,
    config: RuntimeConfig,
    snapshot: SetupSnapshot,
    private readonly adapter: SetupAdapter,
  ) {
    this.activeConfig = config;
    this.snapshot = snapshot;
  }
  static async open(file: string, pythonBinary: string, adapter: SetupAdapter) {
    let snapshot: SetupSnapshot;
    let unreadable = false;
    try {
      snapshot = SetupSnapshotSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    } catch (error) {
      unreadable = (error as NodeJS.ErrnoException).code !== 'ENOENT';
      snapshot = {
        pendingLogin: null,
        modelCredentialsConfigured: false,
        modelConnectionVerified: false,
        schemaVersion: 1,
        stage: 'check',
        busy: false,
        error: null,
        restartRequired: false,
        config: RuntimeConfigSchema.parse({ schemaVersion: 1, sbxBinary: null, sandbox: null, pythonBinary, localRoot: null, ssh: null }),
      };
    }
    // A recorded busy operation is never replayed. Explicit retry reconciles real resources.
    snapshot = {
      ...snapshot,
      busy: false,
      restartRequired: false,
      config: { ...snapshot.config, pythonBinary },
      error: unreadable
        ? { code: 'configuration-invalid', message: '安装记录无法读取，原文件已保留；请修复记录后重新启动' }
        : snapshot.busy
          ? { code: 'interrupted', message: '安装曾被中断；请检查后重试' }
          : snapshot.error,
    };
    return new SetupManager(file, structuredClone(snapshot.config), snapshot, adapter);
  }
  subscribe(listener: (snapshot: SetupSnapshot) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async shutdown() {
    if (!this.operation && this.snapshot.pendingLogin) await this.resumeLogin(true);
    this.operation?.abort();
    await this.idle;
    if (this.snapshot.error?.code === 'cleanup-unconfirmed') throw new Error(this.snapshot.error.message);
  }
  status() {
    return structuredClone(this.snapshot);
  }
  blockInstalledPayload(message: string) {
    this.activeConfig.sbxBinary = null;
    this.activeConfig.sandbox = null;
    this.snapshot = { ...this.snapshot, stage: 'check', error: { code: 'payload-corrupt', message }, restartRequired: true };
  }
  runtimeConfig() {
    return structuredClone(this.activeConfig);
  }
  private async persist() {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(SetupSnapshotSchema.parse(this.snapshot), null, 2), { mode: 0o600 });
    await rename(temporary, this.file);
    for (const listener of this.listeners) listener(this.status());
  }
  private async run(action: (signal: AbortSignal) => Promise<void>, recoveringLogin = false) {
    if (this.snapshot.error?.code === 'configuration-invalid') throw new SetupError('configuration-invalid', this.snapshot.error.message);
    if (this.snapshot.pendingLogin && !recoveringLogin) throw new SetupError('login-pending', '上次登录进程尚待确认，请重试或取消登录');
    if (this.operation) throw new SetupError('busy', '安装操作正在进行');
    const controller = new AbortController();
    this.operation = controller;
    let finish: () => void = () => undefined;
    this.idle = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.snapshot.busy = true;
    this.snapshot.error = null;
    try {
      await this.persist();
      await action(controller.signal);
    } catch (error) {
      const failure = error instanceof SetupError ? error : new SetupError('operation-failed', '安装操作失败，请检查环境后重试');
      this.snapshot.error =
        failure.code === 'cleanup-unconfirmed'
          ? { code: failure.code, message: failure.message }
          : controller.signal.aborted
            ? { code: 'cancelled', message: '安装已取消；重试将先检查实际资源' }
            : { code: failure.code, message: failure.message };
    } finally {
      this.snapshot.busy = false;
      try {
        await this.persist();
      } finally {
        this.operation = null;
        finish();
      }
    }
    return this.status();
  }
  check() {
    return this.run(async (signal) => {
      await this.adapter.check(signal);
    });
  }
  prepare() {
    return this.run(async (signal) => {
      const manifest = await this.adapter.check(signal);
      const config = this.snapshot.config;
      const previousStage = this.snapshot.stage;
      this.snapshot.stage = 'sbx';
      await this.persist();
      config.sbxBinary = await this.adapter.installSbx(signal);
      this.snapshot.restartRequired = true;
      await this.persist();
      if (!config.sandbox && ['check', 'sbx'].includes(previousStage)) {
        this.snapshot.stage = 'docker-login';
        await this.persist();
        return;
      }
      if (!config.sandbox) {
        config.sandbox = 'wsl-competition-' + randomUUID();
        this.snapshot.restartRequired = true;
        await this.persist();
      }
      // Persist the name before create. A failed ACK cannot cause a second sandbox on retry.
      this.snapshot.stage = 'sandbox';
      await this.persist();
      if (!(await this.adapter.sandboxExists(config.sbxBinary, config.sandbox, signal)))
        await this.adapter.createSandbox(config.sbxBinary, config.sandbox, manifest, signal);
      await this.adapter.inspectSandbox(config.sbxBinary, config.sandbox, manifest, signal);
      this.snapshot.stage = 'tools';
      await this.persist();
      await this.adapter.installTools(config.sbxBinary, config.sandbox, manifest, signal);
      this.snapshot.stage = 'probe';
      await this.persist();
      await this.adapter.probe(config.sbxBinary, config.sandbox, signal);
      this.snapshot.modelCredentialsConfigured = await this.adapter.modelConfigured(config.sbxBinary, signal);
      this.snapshot.stage = this.snapshot.modelCredentialsConfigured ? 'ready' : 'model-login';
    });
  }
  retry() {
    return this.snapshot.pendingLogin ? this.resumeLogin(false) : this.prepare();
  }
  cancel() {
    if (!this.operation && this.snapshot.pendingLogin) return this.resumeLogin(true);
    this.operation?.abort();
    return Promise.resolve(this.status());
  }
  private resumeLogin(cancel: boolean) {
    const pending = this.snapshot.pendingLogin;
    const binary = this.snapshot.config.sbxBinary;
    if (!pending || !binary) throw new SetupError('login-pending', '登录记录不完整，请保留记录并检查');
    return this.run(async (signal) => {
      const controller = new AbortController();
      if (cancel) controller.abort();
      await this.completeLogin(binary, pending.provider, AbortSignal.any([signal, controller.signal]), pending.id, true);
    }, true);
  }
  private async completeLogin(binary: string, provider: 'docker' | 'openai', signal: AbortSignal, id: string, resume = false) {
    try {
      await this.adapter.login(binary, provider, signal, id, resume);
      this.snapshot.pendingLogin = null;
    } catch (error) {
      if (!(error instanceof SetupError) || error.code !== 'cleanup-unconfirmed') this.snapshot.pendingLogin = null;
      throw error;
    }
  }
  login(provider: 'docker' | 'openai', acknowledgeGlobalCredentials: boolean) {
    const binary = this.snapshot.config.sbxBinary;
    if (!binary) throw new SetupError('sbx-missing', '请先准备 sbx');
    if (provider === 'openai' && !acknowledgeGlobalCredentials)
      throw new SetupError('consent-required', 'OpenAI OAuth 会更新 sbx 全局凭据，请明确确认');
    return this.run(async (signal) => {
      this.snapshot.stage = provider === 'docker' ? 'docker-login' : 'model-login';
      await this.persist();
      const id = randomUUID();
      this.snapshot.pendingLogin = { id, provider };
      await this.persist();
      await this.completeLogin(binary, provider, signal, id);
      // Login completion is distinct from environment/model verification; prepare checks facts next.
    });
  }
  authorizeLocalRoot(root: string) {
    this.selectedLocalRoot = root;
  }
  async save(raw: unknown) {
    if (this.snapshot.error?.code === 'configuration-invalid') throw new SetupError('configuration-invalid', this.snapshot.error.message);
    if (this.operation) throw new SetupError('busy', '安装操作正在进行');
    const settings = SetupSettingsSchema.parse(raw);
    if (
      settings.localRoot !== null &&
      settings.localRoot !== this.snapshot.config.localRoot &&
      settings.localRoot !== this.selectedLocalRoot
    )
      throw new SetupError('root-not-authorized', '请使用系统目录选择器授权本地目录');
    return this.run(async () => {
      this.snapshot.config = { ...this.snapshot.config, ...settings };
      this.selectedLocalRoot = null;
      this.snapshot.restartRequired = true;
    });
  }
}
