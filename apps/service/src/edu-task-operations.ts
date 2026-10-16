import { EduTaskBindingSchema, type EduTaskBinding } from '@wsl/protocol';
import type { GuestOutcome, GuestProcess } from './sbx';

type Child = Pick<GuestProcess, 'done' | 'close'>;
interface Helper {
  readonly child: Child;
  stopped: Promise<GuestOutcome>;
  resolveStopped: (outcome: GuestOutcome) => void;
  stopping?: Promise<GuestOutcome>;
}
export interface EduTaskOperationOwner {
  binding: EduTaskBinding;
  cancelled: boolean;
  dispatchUnknown: boolean;
  pending: Promise<unknown> | null;
  helper: Helper | null;
}

/** Only finite edu source/prepare/apply helpers, never the long-lived App. */
export class EduTaskOperations {
  private readonly owners = new Map<string, EduTaskOperationOwner>();
  private closing = false;

  admit(input: EduTaskBinding): EduTaskOperationOwner {
    if (this.closing) throw new Error('edu_task_operations_closing');
    const binding = EduTaskBindingSchema.parse(input);
    const existing = this.known(binding);
    if (existing) return existing;
    // Keep cancelled admissions as tombstones so delayed RPCs cannot restart them.
    if (this.owners.size >= 4096) throw new Error('edu_task_operation_limit');
    const owner = { binding: structuredClone(binding), cancelled: false, dispatchUnknown: false, pending: null, helper: null };
    this.owners.set(binding.runId, owner);
    return owner;
  }

  known(input: EduTaskBinding): EduTaskOperationOwner | undefined {
    const binding = EduTaskBindingSchema.parse(input);
    const owner = this.owners.get(binding.runId);
    if (owner && JSON.stringify(owner.binding) !== JSON.stringify(binding)) throw new Error('edu_task_binding_mismatch');
    return owner;
  }

  bindings(target?: { workspaceId: string; projectId: string }): EduTaskBinding[] {
    return [...this.owners.values()]
      .filter((owner) => !target || (owner.binding.workspaceId === target.workspaceId && owner.binding.projectId === target.projectId))
      .map((owner) => structuredClone(owner.binding));
  }

  assertActive(owner: EduTaskOperationOwner): void {
    if (this.closing) throw new Error('edu_task_operations_closing');
    if (owner.cancelled) throw new Error('edu_task_cancelled');
    if (owner.helper || owner.dispatchUnknown) throw new Error('edu_task_helper_cleanup_unknown');
  }

  beginDispatch(owner: EduTaskOperationOwner): void {
    this.assertActive(owner);
    // A launch exception does not prove that the guest received nothing. Only
    // registering the returned child in wait can replace this unknown state.
    owner.dispatchUnknown = true;
  }

  busy(target: { workspaceId: string; projectId: string }): boolean {
    return [...this.owners.values()].some(
      (owner) =>
        owner.binding.workspaceId === target.workspaceId &&
        owner.binding.projectId === target.projectId &&
        (owner.pending !== null || owner.helper !== null || owner.dispatchUnknown),
    );
  }

  clean(binding: EduTaskBinding): boolean {
    const owner = this.known(binding);
    return !!owner && !owner.pending && !owner.helper && !owner.dispatchUnknown;
  }

  async run<T>(owner: EduTaskOperationOwner, work: () => Promise<T>): Promise<T> {
    this.assertActive(owner);
    if (owner.pending || this.busy(owner.binding)) throw new Error('edu_task_operation_busy');
    // Defer work until the pending owner is visible to cancellation.
    const pending = Promise.resolve().then(() => {
      this.assertActive(owner);
      return work();
    });
    owner.pending = pending;
    try {
      return await pending;
    } finally {
      if (owner.pending === pending) owner.pending = null;
    }
  }

  private stop(helper: Helper): Promise<GuestOutcome> {
    if (!helper.stopping) {
      helper.stopping = Promise.resolve()
        .then(() => helper.child.close())
        .catch((): GuestOutcome => ({ confirmed: false, exitCode: null, error: 'edu_task_helper_cleanup_unknown' }));
      void helper.stopping.then((outcome) => {
        helper.resolveStopped(outcome);
        if (!outcome.confirmed) helper.stopping = undefined;
      });
    }
    return helper.stopping;
  }

  async wait(owner: EduTaskOperationOwner, child: Child, timeoutMs: number): Promise<GuestOutcome> {
    // beginDispatch already checked admission. The child now exists, so a late
    // cancel/close must register and stop it rather than throw away its handle.
    let resolveStopped: ((outcome: GuestOutcome) => void) | undefined;
    const stopped = new Promise<GuestOutcome>((resolve) => {
      resolveStopped = resolve;
    });
    const helper: Helper = { child, stopped, resolveStopped: (outcome) => resolveStopped?.(outcome) };
    owner.helper = helper;
    owner.dispatchUnknown = false;
    if (owner.cancelled || this.closing) {
      owner.cancelled = true;
      void this.stop(helper);
    }
    const timer = setTimeout(() => {
      owner.cancelled = true;
      void this.stop(helper);
    }, timeoutMs);
    try {
      const outcome = await Promise.race([
        child.done.catch((): GuestOutcome => ({ confirmed: false, exitCode: null, error: 'edu_task_helper_transport_lost' })),
        stopped,
      ]);
      const cleanup = helper.stopping ? await helper.stopping : outcome;
      if (outcome.confirmed && cleanup.confirmed) {
        if (owner.helper === helper) owner.helper = null;
        return outcome;
      }
      return { confirmed: false, exitCode: outcome.exitCode, error: 'edu_task_helper_cleanup_unknown' };
    } finally {
      clearTimeout(timer);
    }
  }

  async cancel(binding: EduTaskBinding): Promise<boolean> {
    const owner = this.known(binding);
    // Cancellation may arrive before admission. Retain its full binding so a
    // delayed prepare cannot resurrect it; absence never proves guest cleanup.
    if (!owner) {
      const parsed = EduTaskBindingSchema.parse(binding);
      if (this.owners.size < 4096) {
        this.owners.set(parsed.runId, {
          binding: structuredClone(parsed),
          cancelled: true,
          dispatchUnknown: true,
          pending: null,
          helper: null,
        });
      }
      return false;
    }
    owner.cancelled = true;
    const helper = owner.helper;
    const outcome = helper ? await this.stop(helper) : null;
    if (owner.pending) await Promise.allSettled([owner.pending]);
    if (helper && outcome?.confirmed && owner.helper === helper) owner.helper = null;
    return this.clean(binding);
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    // Close every finite helper even when another owner's cleanup fails.
    const outcomes = await Promise.allSettled([...this.owners.values()].map((owner) => this.cancel(owner.binding)));
    const errors = outcomes
      .filter((outcome) => outcome.status === 'rejected' || !outcome.value)
      .map(() => new Error('edu_task_helper_cleanup_unknown'));
    if (errors.length) throw new AggregateError(errors, 'edu_task_helper_cleanup_unknown');
  }
}
