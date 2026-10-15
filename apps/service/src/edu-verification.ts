import type { AdmissionRecoveryRecord, RecoveryJournal, RecoveryRecord } from './edu-recovery-journal';
import { randomUUID } from 'node:crypto';
import type {
  EduAdmissionRecoveryStatus,
  EduVerificationBegin,
  EduVerificationLease,
  EduVerificationStatus,
  EduVerificationTarget,
} from '@wsl/protocol';
import type { AppService, AppKey } from './app-service';
import { parseRequest, parseResponse } from './edu-assessment';
import { loadProviderConfig, runProvider, type ProviderConfig, type ProviderRunner } from './edu-provider';
import type { MaintenanceGate } from './maintenance-gate';
const safeCode = (error: unknown, fallback: string) =>
  error instanceof Error && /^verification_[a-z0-9_]{1,100}$/.test(error.message) ? error.message : fallback;
type Apps = Pick<
  AppService,
  | 'restore'
  | 'export'
  | 'stop'
  | 'start'
  | 'writeVerification'
  | 'closeVerificationInput'
  | 'inspectRecovery'
  | 'captureRecoverySource'
  | 'recoverOwned'
>;
export class EduVerificationService {
  private current: EduVerificationStatus | null = null;
  private provider: ProviderConfig | null = null;
  private pending: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private requests = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private preparing: Promise<EduVerificationStatus> | null = null;
  private ending: Promise<EduVerificationStatus> | null = null;
  private owned = false;
  private leased = false;
  private drainUnconfirmed = false;
  private urls = new Set<string>();
  private recovery: RecoveryRecord | null = null;
  private recoveryRequired = false;
  private journalStarted = false;
  private admission: AdmissionRecoveryRecord | null = null;
  private admitting: Promise<EduAdmissionRecoveryStatus> | null = null;
  constructor(
    private readonly apps: Apps,
    readonly gate: MaintenanceGate,
    private readonly drain: () => Promise<void>,
    private readonly options: {
      loadConfig?: () => Promise<ProviderConfig>;
      runner?: ProviderRunner;
      now?: () => number;
      onStatus?: (status: EduVerificationStatus) => void;
      onAdmissionStatus?: (status: EduAdmissionRecoveryStatus) => void;
      fetch?: typeof fetch;
      journal?: RecoveryJournal;
      ensureReady?: () => Promise<void>;
    } = {},
  ) {}
  async initialize(): Promise<void> {
    const recovery = await this.options.journal?.open();
    if (!recovery) return;
    if (recovery.status.phase === 'ended' && !this.admitting && !this.preparing) this.gate.release();
    if ('admissionOnly' in recovery) {
      this.admission = recovery;
      if (recovery.status.phase !== 'ended') {
        recovery.status.phase = 'failed';
        recovery.status.error = 'verification_admission_recovery_required';
      }
      if (recovery.status.phase !== 'ended') this.publishAdmission();
      return;
    }
    this.recovery = recovery;
    this.current = structuredClone(recovery.status);
    this.urls = new Set(recovery.urls);
    this.owned = recovery.ownershipTaken;
    this.recoveryRequired = this.current.phase !== 'ended';
    if (this.recoveryRequired) {
      this.current.phase = 'failed';
      this.current.error = 'verification_recovery_required';
    }
    if (this.current.phase !== 'ended') this.publish();
  }
  private async checkpoint(ended = false): Promise<void> {
    if (!this.recovery) return;
    this.recovery.status = structuredClone(this.current!);
    this.recovery.status.maintenanceLocked = !ended;
    this.recovery.urls = [...this.urls];
    this.recovery.ownershipTaken = this.owned;
    await this.options.journal?.write(this.recovery);
  }
  reconcile(target: EduVerificationTarget): Promise<EduVerificationStatus> {
    this.status(target);
    if (this.ending) return this.ending;
    if (!this.recovery || (!this.recoveryRequired && this.current!.phase !== 'ended'))
      return Promise.reject(new Error('verification_recovery_not_required'));
    const completed = !this.recoveryRequired && this.current!.phase === 'ended';
    if (!this.gate.isLocked()) this.gate.acquire();
    const work = (async () => {
      try {
        await this.drain();
        const key = this.key(),
          lease = this.current!.lease;
        const facts = await this.apps.inspectRecovery(key);
        const allowed = completed
          ? [this.recovery!.restoreInstanceIds.at(-1)]
          : [this.recovery!.originalIdentity.appInstanceId, lease.identity.appInstanceId, ...this.recovery!.restoreInstanceIds];
        if (!facts.appInstanceId || !allowed.includes(facts.appInstanceId) || facts.sourceSha256 !== lease.sourceSha256)
          throw new Error('verification_recovery_identity_mismatch');
        if ((await this.apps.captureRecoverySource(key)) !== lease.sourceSha256) throw new Error('verification_recovery_source_changed');
        if (completed) {
          const running = await this.apps.restore(key);
          if (running.state === 'running' && running.appInstanceId === facts.appInstanceId && running.sourceSha256 === lease.sourceSha256) {
            this.gate.release();
            return this.publish();
          }
        }
        this.recoveryRequired = true;
        if (facts.url) this.urls.add(facts.url);
        this.current!.phase = 'revoking';
        await this.checkpoint();
        this.publish();
        const stopped = await this.apps.stop(key);
        if (!stopped.cleanupConfirmed) throw new Error(safeCode(new Error(stopped.error ?? ''), 'verification_cleanup_unconfirmed'));
        for (const url of this.urls) await this.assertUrlClosed(url);
        if (this.recovery!.restoreInstanceIds.length >= 16) throw new Error('verification_recovery_attempt_budget');
        const reserved = randomUUID();
        this.recovery!.restoreInstanceIds.push(reserved);
        this.current!.phase = 'restoring';
        await this.checkpoint();
        this.publish();
        const restored = await this.apps.start(key, undefined, reserved);
        if (restored.url) this.urls.add(restored.url);
        if (restored.state !== 'running' || restored.appInstanceId !== reserved || restored.sourceSha256 !== lease.sourceSha256)
          throw new Error('verification_recovery_restore_unconfirmed');
        this.current!.phase = 'ended';
        this.current!.error = null;
        await this.checkpoint(true);
        this.recoveryRequired = false;
        this.gate.release();
        return this.publish();
      } catch (error) {
        this.current!.phase = 'failed';
        this.current!.error = safeCode(error, 'verification_recovery_unconfirmed');
        this.publish();
        throw new Error(this.current!.error, { cause: error });
      }
    })();
    this.ending = work;
    void work
      .finally(() => {
        if (this.ending === work) this.ending = null;
      })
      .catch(() => undefined);
    return work;
  }
  private publishAdmission(): EduAdmissionRecoveryStatus {
    const status = this.admission!.status;
    status.maintenanceLocked = this.gate.isLocked();
    this.options.onAdmissionStatus?.(structuredClone(status));
    return structuredClone(status);
  }
  recoverAdmission(input: EduVerificationBegin): Promise<EduAdmissionRecoveryStatus> {
    const key: AppKey = { workspaceId: input.workspaceId, projectId: input.projectId };
    if (
      this.preparing ||
      this.ending ||
      this.admitting ||
      this.recoveryRequired ||
      (this.current && this.current.phase !== 'ended' && this.gate.isLocked())
    )
      return Promise.reject(new Error('verification_maintenance_locked'));
    const previouslyLocked = this.gate.isLocked();
    if (!previouslyLocked) this.gate.acquire();
    const work = (async () => {
      let durable = false;
      let readyConfirmed = false;
      try {
        await this.options.ensureReady?.();
        readyConfirmed = true;
        if (this.recoveryRequired || (this.current && this.current.phase !== 'ended')) throw new Error('verification_maintenance_locked');
        if (!this.gate.isLocked()) this.gate.acquire();
        const record =
          this.admission &&
          (this.admission.status.phase !== 'ended' ||
            (this.admission.status.originalIdentity.workspaceId === input.workspaceId &&
              this.admission.status.originalIdentity.projectId === input.projectId &&
              this.admission.status.originalIdentity.appInstanceId === input.appInstanceId &&
              this.admission.status.sourceSha256 === input.sourceSha256))
            ? this.admission
            : null;
        if (record) {
          const original = record.status.originalIdentity;
          if (
            original.workspaceId !== input.workspaceId ||
            original.projectId !== input.projectId ||
            original.appInstanceId !== input.appInstanceId ||
            record.status.sourceSha256 !== input.sourceSha256
          )
            throw new Error('verification_recovery_identity_mismatch');
          durable = record.status.phase !== 'ended';
        }
        const facts = await this.apps.inspectRecovery(key);
        const allowed = record
          ? record.status.phase === 'ended'
            ? [record.status.restoredIdentity?.appInstanceId]
            : [input.appInstanceId, ...record.restoreInstanceIds]
          : [input.appInstanceId];
        if (!facts.appInstanceId || !allowed.includes(facts.appInstanceId) || facts.sourceSha256 !== input.sourceSha256)
          throw new Error('verification_recovery_identity_mismatch');
        if ((await this.apps.captureRecoverySource(key)) !== input.sourceSha256) throw new Error('verification_recovery_source_changed');
        if (record?.status.phase === 'ended') {
          const running = await this.apps.restore(key);
          if (
            running.state === 'running' &&
            running.appInstanceId === record.status.restoredIdentity?.appInstanceId &&
            running.sourceSha256 === input.sourceSha256
          ) {
            this.gate.release();
            return this.publishAdmission();
          }
          record.status.phase = 'revoking';
          record.status.maintenanceLocked = true;
          durable = true;
        }
        if (!record) {
          const reserved = randomUUID();
          this.admission = {
            schemaVersion: 1,
            admissionOnly: true,
            status: {
              schemaVersion: 1,
              kind: 'admission-recovery',
              recoveryId: randomUUID(),
              originalIdentity: {
                workspaceId: input.workspaceId,
                projectId: input.projectId,
                environmentId: 'sandbox',
                appInstanceId: input.appInstanceId,
              },
              sourceSha256: input.sourceSha256,
              phase: 'revoking',
              restoredIdentity: null,
              maintenanceLocked: true,
              error: null,
            },
            restoreInstanceIds: [reserved],
            urls: facts.url ? [facts.url] : [],
          };
        } else if (facts.url && !record.urls.includes(facts.url)) record.urls.push(facts.url);
        durable = true;
        await this.options.journal!.write(this.admission!);
        this.publishAdmission();
        await this.drain();
        const frozen = await this.apps.inspectRecovery(key);
        if (frozen.appInstanceId !== facts.appInstanceId || frozen.sourceSha256 !== input.sourceSha256)
          throw new Error('verification_recovery_identity_mismatch');
        if ((await this.apps.captureRecoverySource(key)) !== input.sourceSha256) throw new Error('verification_recovery_source_changed');
        // Admission cancels a normal AI-disabled instance; app.stop itself uses
        // durable PID/start-time recovery when the service lost its process handle.
        const stopped = await this.apps.stop(key);
        if (!stopped.cleanupConfirmed) throw new Error(safeCode(new Error(stopped.error ?? ''), 'verification_cleanup_unconfirmed'));
        for (const url of this.admission!.urls) await this.assertUrlClosed(url);
        const ids = this.admission!.restoreInstanceIds;
        if (record) {
          if (ids.length >= 16) throw new Error('verification_recovery_attempt_budget');
          ids.push(randomUUID());
        }
        const reserved = ids.at(-1)!;
        this.admission!.status.phase = 'restoring';
        this.admission!.status.restoredIdentity = { ...this.admission!.status.originalIdentity, appInstanceId: reserved };
        await this.options.journal!.write(this.admission!);
        this.publishAdmission();
        const restored = await this.apps.start(key, undefined, reserved);
        if (restored.url && !this.admission!.urls.includes(restored.url)) this.admission!.urls.push(restored.url);
        if (restored.state !== 'running' || restored.appInstanceId !== reserved || restored.sourceSha256 !== input.sourceSha256)
          throw new Error('verification_recovery_restore_unconfirmed');
        this.admission!.status.phase = 'ended';
        this.admission!.status.error = null;
        this.admission!.status.maintenanceLocked = false;
        await this.options.journal!.write(this.admission!);
        this.gate.release();
        return this.publishAdmission();
      } catch (error) {
        if (durable && this.admission) {
          this.admission.status.phase = 'failed';
          this.admission.status.error = safeCode(error, 'verification_admission_recovery_unconfirmed');
          this.publishAdmission();
        } else if (
          readyConfirmed &&
          !this.recoveryRequired &&
          (!this.current || this.current.phase === 'ended') &&
          (!this.admission || this.admission.status.phase === 'ended')
        )
          this.gate.release();
        throw new Error(safeCode(error, 'verification_admission_recovery_unconfirmed'), { cause: error });
      }
    })();
    this.admitting = work;
    void work
      .finally(() => {
        if (this.admitting === work) this.admitting = null;
      })
      .catch(() => undefined);
    return work;
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private publish() {
    const status = this.current!;
    status.maintenanceLocked = this.gate.isLocked();
    this.options.onStatus?.(structuredClone(status));
    return structuredClone(status);
  }
  private key(): AppKey {
    return { workspaceId: this.current!.lease.identity.workspaceId, projectId: this.current!.lease.identity.projectId };
  }
  private target(): EduVerificationTarget {
    const { lease } = this.current!;
    return { ...this.key(), appInstanceId: lease.identity.appInstanceId, sessionId: lease.sessionId };
  }
  status(target: EduVerificationTarget): EduVerificationStatus {
    const lease = this.current?.lease;
    if (
      !lease ||
      target.sessionId !== lease.sessionId ||
      target.appInstanceId !== lease.identity.appInstanceId ||
      target.workspaceId !== lease.identity.workspaceId ||
      target.projectId !== lease.identity.projectId
    )
      throw new Error('verification_session_mismatch');
    return structuredClone(this.current!);
  }
  begin(input: EduVerificationBegin): Promise<EduVerificationStatus> {
    // AppService accepts a strict project key; frozen instance/source remain in input.
    const key: AppKey = { workspaceId: input.workspaceId, projectId: input.projectId };
    if (
      this.preparing ||
      this.ending ||
      this.admitting ||
      this.recoveryRequired ||
      (this.current && this.current.phase !== 'ended' && this.gate.isLocked()) ||
      (this.admission && this.admission.status.phase !== 'ended')
    )
      return Promise.reject(new Error('verification_maintenance_locked'));
    this.gate.acquire();
    this.journalStarted = false;
    const lease: EduVerificationLease = {
      schemaVersion: 1,
      sessionId: randomUUID(),
      identity: { workspaceId: input.workspaceId, projectId: input.projectId, environmentId: 'sandbox', appInstanceId: randomUUID() },
      sourceSha256: input.sourceSha256,
      expiresAtMs: this.now() + 300000,
    };
    this.current = { lease, phase: 'preparing', callsUsed: 0, maintenanceLocked: true, error: null };
    this.requests.clear();
    this.urls.clear();
    this.owned = false;
    this.leased = false;
    this.drainUnconfirmed = false;
    this.publish();
    this.timer = setTimeout(() => {
      this.fail('verification_expired');
    }, 300000);
    this.timer.unref?.();
    const work = (async () => {
      try {
        await this.options.ensureReady?.();
        this.provider = await (this.options.loadConfig ?? (() => loadProviderConfig(process.env['WSL_EDU_PROVIDER_CONFIG'])))();
        const before = await this.apps.restore(key);
        if (
          before.profile.projectKind !== 'edu-web' ||
          before.state !== 'running' ||
          before.appInstanceId !== input.appInstanceId ||
          before.sourceSha256 !== input.sourceSha256
        )
          throw new Error('verification_source_or_instance_changed');
        this.recovery = {
          schemaVersion: 1,
          status: structuredClone(this.current!),
          originalIdentity: {
            workspaceId: input.workspaceId,
            environmentId: 'sandbox',
            projectId: input.projectId,
            appInstanceId: input.appInstanceId,
          },
          restoreInstanceIds: [],
          urls: before.url ? [before.url] : [],
          ownershipTaken: false,
        };
        if (before.url) this.urls.add(before.url);
        this.journalStarted = Boolean(this.options.journal);
        await this.checkpoint();
        this.drainUnconfirmed = true;
        await this.drain();
        this.drainUnconfirmed = false;
        await this.apps.export(key, true);
        const actual = await this.apps.restore(key);
        if (actual.appInstanceId !== input.appInstanceId || actual.sourceSha256 !== input.sourceSha256)
          throw new Error('verification_source_or_instance_changed');
        this.assertPreparing();
        this.owned = true;
        await this.checkpoint();
        if (before.url) this.urls.add(before.url);
        const stopped = await this.apps.stop(key);
        if (!stopped.cleanupConfirmed) throw new Error(safeCode(new Error(stopped.error ?? ''), 'verification_cleanup_unconfirmed'));
        await this.assertUrlClosed(before.url);
        this.assertPreparing();
        this.leased = true;
        const running = await this.apps.start(key, {
          lease,
          request: (line) => {
            if (this.current?.lease.sessionId === lease.sessionId) this.request(line);
          },
          fail: () => {
            if (this.current?.lease.sessionId === lease.sessionId) this.fail('verification_invalid_guest_frame');
          },
        });
        this.assertPreparing();
        if (
          running.state !== 'running' ||
          running.appInstanceId !== lease.identity.appInstanceId ||
          running.sourceSha256 !== lease.sourceSha256
        )
          throw new Error('verification_start_unconfirmed');
        if (running.url) this.urls.add(running.url);
        this.current!.phase = 'active';
        await this.checkpoint();
        return this.publish();
      } catch (error) {
        this.current!.phase = 'failed';
        this.current!.error ??= safeCode(error, 'verification_begin_failed');
        if (!this.owned) {
          if (this.timer) clearTimeout(this.timer);
          this.timer = null;
          if (!this.drainUnconfirmed) {
            if (this.journalStarted) {
              this.recoveryRequired = true;
              try {
                await this.checkpoint();
              } catch (error) {
                this.current!.error = safeCode(error, 'verification_journal_unconfirmed');
              }
            } else this.gate.release();
          } else this.current!.error = 'verification_drain_unconfirmed';
        }
        this.publish();
        if (this.owned)
          void this.end(this.target()).catch(() => {
            this.publish();
          });
        throw new Error(this.current!.error, { cause: error });
      }
    })();
    this.preparing = work;
    void work
      .finally(() => {
        if (this.preparing === work) this.preparing = null;
      })
      .catch(() => undefined);
    return work;
  }
  private assertPreparing() {
    if (this.current!.phase !== 'preparing' || this.now() >= this.current!.lease.expiresAtMs)
      throw new Error('verification_preparation_revoked');
  }
  private assertActive() {
    if (this.current!.phase !== 'active' || this.now() >= this.current!.lease.expiresAtMs || this.controller?.signal.aborted)
      throw new Error('verification_inactive');
  }
  private request(line: string): void {
    if (this.pending) {
      this.fail('verification_concurrent_request');
      return;
    }
    try {
      this.assertActive();
    } catch {
      this.fail('verification_inactive');
      return;
    }
    let request;
    try {
      request = parseRequest(line, this.current!.lease);
      if (this.requests.has(request.requestId) || this.current!.callsUsed >= 2) throw new Error('verification_budget_or_replay');
    } catch {
      this.fail('verification_invalid_request');
      return;
    }
    this.requests.add(request.requestId);
    this.current!.callsUsed++;
    this.publish();
    const controller = new AbortController();
    this.controller = controller;
    let providerTimedOut = false;
    const timeout = setTimeout(
      () => {
        if (this.current!.phase !== 'active' || this.controller !== controller || controller.signal.aborted) return;
        if (this.now() >= this.current!.lease.expiresAtMs) {
          this.fail('verification_expired');
          return;
        }
        providerTimedOut = true;
        controller.abort();
      },
      Math.min(45000, this.current!.lease.expiresAtMs - this.now()),
    );
    const work = (async () => {
      try {
        const raw = await (this.options.runner ?? runProvider)(this.provider!, JSON.stringify(request) + '\n', controller.signal);
        this.assertActive();
        const response = parseResponse(raw, request);
        this.assertActive();
        this.apps.writeVerification(this.key(), this.current!.lease.sessionId, response);
      } catch {
        // Only our request timer establishes timeout; runner text is untrusted.
        // Revocation/expiry may already have published its authoritative reason.
        if (this.current!.phase === 'active')
          this.fail(
            this.now() >= this.current!.lease.expiresAtMs
              ? 'verification_expired'
              : providerTimedOut
                ? 'verification_provider_timeout'
                : 'verification_provider_failed',
          );
      } finally {
        clearTimeout(timeout);
        if (this.controller === controller) this.controller = null;
      }
    })();
    this.pending = work;
    void work
      .finally(() => {
        if (this.pending === work) this.pending = null;
      })
      .catch(() => undefined);
  }
  private fail(code: string) {
    if (
      !this.current ||
      this.current.phase === 'ended' ||
      this.current.phase === 'restoring' ||
      this.current.phase === 'revoking' ||
      this.current.phase === 'revoked'
    )
      return;
    this.current.phase = 'failed';
    this.current.error = code;
    this.controller?.abort();
    this.publish();
    // A broken channel is revoked immediately; process cleanup remains an explicit receipt.
    if (this.leased) this.apps.closeVerificationInput(this.key(), this.current.lease.sessionId);
    if (this.owned)
      void this.end(this.target()).catch(() => {
        this.publish();
      });
  }
  end(target: EduVerificationTarget, restore = true): Promise<EduVerificationStatus> {
    this.status(target);
    if (this.recoveryRequired) throw new Error('verification_recovery_required');
    if (this.current!.phase === 'ended') return Promise.resolve(this.publish());
    if (!this.owned) {
      if (this.preparing) {
        this.current!.phase = 'revoking';
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.publish();
        return this.preparing.then(
          () => this.publish(),
          () => this.publish(),
        );
      }
      return Promise.resolve(this.publish());
    }
    if (this.current!.phase === 'revoked' && !restore) return Promise.resolve(this.publish());
    if (this.ending) return this.ending;
    this.current!.phase = 'revoking';
    this.controller?.abort();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.publish();
    const work = (async () => {
      try {
        // Preparing may still own a startup operation; wait for its cancellation check.
        if (this.preparing) {
          await this.apps.stop(this.key());
          await Promise.allSettled([this.preparing]);
        }
        this.current!.phase = 'revoking';
        if (this.pending) await this.pending;
        const old = await this.apps.restore(this.key());
        if (old.url) this.urls.add(old.url);
        if (this.leased && old.appInstanceId === this.current!.lease.identity.appInstanceId)
          this.apps.closeVerificationInput(this.key(), this.current!.lease.sessionId);
        const stopped = await this.apps.stop(this.key());
        if (!stopped.cleanupConfirmed) throw new Error(safeCode(new Error(stopped.error ?? ''), 'verification_cleanup_unconfirmed'));
        for (const url of this.urls) await this.assertUrlClosed(url);
        this.leased = false;
        if (!restore) {
          this.current!.phase = 'revoked';
          await this.checkpoint();
          return this.publish();
        }
        this.current!.phase = 'restoring';
        const reserved = randomUUID();
        if (this.recovery) this.recovery.restoreInstanceIds.push(reserved);
        await this.checkpoint();
        this.publish();
        const restored = await this.apps.start(this.key(), undefined, reserved);
        if (
          restored.state !== 'running' ||
          restored.appInstanceId !== reserved ||
          restored.appInstanceId === this.current!.lease.identity.appInstanceId ||
          restored.sourceSha256 !== this.current!.lease.sourceSha256
        )
          throw new Error('verification_restore_unconfirmed');
        if (restored.url) this.urls.add(restored.url);
        this.current!.phase = 'ended';
        await this.checkpoint(true);
        this.gate.release();
        return this.publish();
      } catch (error) {
        this.current!.phase = 'failed';
        this.current!.error = safeCode(error, 'verification_revoke_unconfirmed');
        this.publish();
        throw new Error(this.current!.error, { cause: error });
      }
    })();
    this.ending = work;
    void work
      .finally(() => {
        if (this.ending === work) this.ending = null;
      })
      .catch(() => undefined);
    return work;
  }
  async stopCurrent(key: AppKey): Promise<boolean> {
    if (
      !this.current ||
      this.current.phase === 'ended' ||
      key.workspaceId !== this.current.lease.identity.workspaceId ||
      key.projectId !== this.current.lease.identity.projectId
    )
      return false;
    const owned = this.owned;
    await this.end(this.target(), false);
    return owned;
  }
  async shutdown(): Promise<void> {
    this.controller?.abort();
    if (this.timer) clearTimeout(this.timer);
    if (this.current && this.current.phase !== 'ended' && !this.recoveryRequired) await this.end(this.target(), false);
    else if (this.pending) await this.pending;
  }
  private async assertUrlClosed(url: string | null) {
    if (!url) return;
    let responded = false;
    try {
      await (this.options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(1500) });
      responded = true;
    } catch (error) {
      const code = (error as { cause?: { code?: string } }).cause?.code;
      if (code !== 'ECONNREFUSED' && code !== 'ECONNRESET') throw new Error('verification_old_url_unconfirmed', { cause: error });
    }
    if (responded) throw new Error('verification_old_url_live');
  }
}
