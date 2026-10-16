/** Admission epochs prevent requests queued before a lease from launching afterwards. */
export class MaintenanceGate {
  private epoch = 0;
  private locked = false;
  private pending = new Set<Promise<unknown>>();
  acquire(): void {
    if (this.locked) throw new Error('verification_busy');
    this.locked = true;
    this.epoch++;
  }
  release(): void {
    this.locked = false;
  }
  admission(): () => void {
    this.assertOpen();
    const epoch = this.epoch;
    return () => {
      this.assertOpen();
      if (epoch !== this.epoch) throw new Error('verification_admission_revoked');
    };
  }
  assertOpen(): void {
    if (this.locked) throw new Error('verification_maintenance_locked');
  }
  track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => undefined);
    return operation;
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
  isLocked(): boolean {
    return this.locked;
  }
}
