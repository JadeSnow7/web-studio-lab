import {
  MotaControlRequestSchema,
  MotaControlResponseSchema,
  MotaTaskBindingSchema,
  type MotaControlRequest,
  type MotaControlResponse,
  type MotaTaskBinding,
} from '@wsl/protocol';

type Owner = { binding: MotaTaskBinding; dispatched: boolean; acquired: boolean; released: boolean; revoked: boolean };
/** Finite, run-bound control receipts on the existing owned App pipe. No write retries. */
export class MotaControls {
  private readonly owners = new Map<string, Owner>();
  private readonly pending = new Map<
    string,
    { request: MotaControlRequest; resolve: (response: MotaControlResponse) => void; reject: (error: Error) => void }
  >();
  constructor(private readonly timeoutMs = 5000) {}
  private key(binding: MotaTaskBinding): string {
    return JSON.stringify(MotaTaskBindingSchema.parse(binding));
  }
  register(input: MotaTaskBinding): void {
    const binding = MotaTaskBindingSchema.parse(input);
    const key = this.key(binding);
    if (this.owners.has(key)) return;
    if (this.owners.size >= 512) throw new Error('mota_owner_budget_exceeded');
    this.owners.set(key, { binding, dispatched: false, acquired: false, released: false, revoked: false });
  }
  assertActive(binding: MotaTaskBinding): void {
    const owner = this.owners.get(this.key(binding));
    if (!owner?.acquired || owner.revoked || owner.released) throw new Error('mota_lease_not_active');
  }
  hasUnsettled(workspaceId: string, projectId: string): boolean {
    return [...this.owners.values()].some(
      (owner) => owner.binding.workspaceId === workspaceId && owner.binding.projectId === projectId && !owner.released,
    );
  }
  retireReleased(workspaceId: string, projectId: string): void {
    // Only called by an explicit App start after the previous owner is clean.
    // The new appInstanceId rejects every stale binding at the dispatch boundary.
    for (const [key, owner] of this.owners)
      if (owner.released && owner.binding.workspaceId === workspaceId && owner.binding.projectId === projectId) this.owners.delete(key);
  }
  receive(input: unknown): boolean {
    const parsed = MotaControlResponseSchema.safeParse(input);
    if (!parsed.success) return false;
    const response = parsed.data;
    const pending = this.pending.get(response.requestId);
    // Late responses cannot clear an unknown owner; only a new explicit reconciliation can.
    if (!pending) return true;
    if (pending.request.method !== response.method || this.key(pending.request.binding) !== this.key(response.binding)) {
      pending.reject(new Error('mota_control_receipt_identity_mismatch'));
      return true;
    }
    if (
      response.ok &&
      ((response.method === 'map.set' &&
        pending.request.method === 'map.set' &&
        (response.data.operationId !== pending.request.input.operationId ||
          response.data.beforeSha256 !== pending.request.input.expectedSha256 ||
          response.data.change.x !== pending.request.input.x ||
          response.data.change.y !== pending.request.input.y)) ||
        (response.method === 'operation.read' &&
          pending.request.method === 'operation.read' &&
          response.data.operationId !== pending.request.input.operationId))
    ) {
      pending.reject(new Error('mota_control_operation_receipt_mismatch'));
      return true;
    }
    const owner = this.owners.get(this.key(response.binding));
    if (owner && response.ok) {
      if (response.method === 'acquire') owner.acquired = true;
      if (response.method === 'release') {
        owner.released = true;
        owner.acquired = false;
      }
    }
    pending.resolve(response);
    return true;
  }
  async call(input: MotaControlRequest, write: (request: MotaControlRequest) => void): Promise<MotaControlResponse> {
    const request = MotaControlRequestSchema.parse(input);
    const owner = this.owners.get(this.key(request.binding));
    const failure = (code: 'owner_unknown' | 'lease_revoked' | 'busy', message: string): MotaControlResponse => ({
      type: 'mota-control-result',
      requestId: request.requestId,
      binding: request.binding,
      method: request.method,
      ok: false,
      error: { code, message },
    });
    if (!owner) return failure('owner_unknown', '运行租约归属未知，不能确认清理');
    if (request.method === 'release') {
      owner.revoked = true;
      if (owner.released || !owner.dispatched) {
        owner.released = true;
        return {
          type: 'mota-control-result',
          requestId: request.requestId,
          binding: request.binding,
          method: 'release',
          ok: true,
          data: { settled: true },
        };
      }
    } else if (request.method !== 'operation.read' && (owner.revoked || owner.released))
      return failure('lease_revoked', '运行已取消或释放');
    if (request.method !== 'acquire' && request.method !== 'release' && request.method !== 'operation.read' && !owner.acquired)
      return failure('busy', '运行租约尚未确认');
    if (this.pending.has(request.requestId) || this.pending.size >= 32) throw new Error('mota_control_request_budget_or_duplicate');
    // Mark before the write: a thrown transport cannot prove no bytes were accepted.
    owner.dispatched = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<MotaControlResponse>((resolve, reject) => {
        this.pending.set(request.requestId, { request, resolve, reject });
        timer = setTimeout(() => reject(new Error('魔塔控制回执超时；占用保留，禁止自动重放')), this.timeoutMs);
        try {
          write(request);
        } catch (error) {
          reject(error);
        }
      });
    } finally {
      if (timer) clearTimeout(timer);
      this.pending.delete(request.requestId);
    }
  }
}
