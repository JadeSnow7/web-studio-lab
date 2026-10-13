import { AgentDataError } from './data.js';

type Operation = 'seed' | 'reset';
type Envelope = { ok: true; data: Record<string, unknown> } | { ok: false; error: { code: string; message: string } };
export interface OperationReceipt {
  operationId: string;
  appInstanceId: string;
  operation: Operation;
  state: 'running' | 'succeeded' | 'failed' | 'cancelled_before_start';
  envelope?: Envelope;
}
interface Entry {
  receipt: OperationReceipt;
  result: Promise<Envelope>;
}
export class OperationError extends Error {
  constructor(
    readonly code: 'operation_conflict' | 'operation_capacity',
    message: string,
  ) {
    super(message);
  }
}

/** Instance-lifetime identities must never be evicted: late requests must not repeat writes. */
export class AgentOperations {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly appInstanceId: string) {}
  get(id: string) {
    return this.entries.get(id)?.receipt;
  }
  private existing(id: string, operation: Operation) {
    const entry = this.entries.get(id);
    if (entry && entry.receipt.operation !== operation)
      throw new OperationError('operation_conflict', 'Operation ID belongs to another operation');
    return entry;
  }
  private reserve(id: string, operation: Operation, state: OperationReceipt['state']): OperationReceipt {
    if (this.entries.size >= 1024) throw new OperationError('operation_capacity', 'Instance operation registry is full');
    return { operationId: id, appInstanceId: this.appInstanceId, operation, state };
  }
  cancel(id: string, operation: Operation) {
    const entry = this.existing(id, operation);
    if (entry) return entry.receipt;
    const receipt = this.reserve(id, operation, 'cancelled_before_start');
    const envelope: Envelope = { ok: false, error: { code: 'cancelled', message: 'Operation cancelled before start' } };
    receipt.envelope = envelope;
    this.entries.set(id, { receipt, result: Promise.resolve(envelope) });
    return receipt;
  }
  execute(id: string, operation: Operation, work: () => Promise<Record<string, unknown>>): Promise<Envelope> {
    const existing = this.existing(id, operation);
    if (existing) return existing.result;
    const receipt = this.reserve(id, operation, 'running');
    // Defer work until registration is complete, including synchronous failures.
    const result = Promise.resolve()
      .then(work)
      .then(
        (data): Envelope => {
          receipt.state = 'succeeded';
          return (receipt.envelope = { ok: true, data });
        },
        (error: unknown): Envelope => {
          receipt.state = 'failed';
          return (receipt.envelope = {
            ok: false,
            error: {
              code: error instanceof AgentDataError ? error.code : 'unavailable',
              message: error instanceof Error ? error.message : String(error),
            },
          });
        },
      );
    this.entries.set(id, { receipt, result });
    return result;
  }
}
