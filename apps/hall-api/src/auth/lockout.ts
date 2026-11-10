// Failed attempts per key (an address; an address and an e-mail) in a sliding window: after `max`
// failures the key is locked until the oldest one leaves the window. In memory: a restart forgets,
// which is acceptable for a brute-force brake on one API process.
export class Lockout {
  private readonly failures = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Seconds until the key may try again; 0 when it may now. */
  retryAfterS(key: string, nowMs: number): number {
    const list = this.prune(key, nowMs);
    if (list.length < this.max) return 0;
    return Math.max(1, Math.ceil((list[0]! + this.windowMs - nowMs) / 1000));
  }

  /** Records a failure; returns how many attempts are left. */
  fail(key: string, nowMs: number): number {
    const list = this.prune(key, nowMs);
    list.push(nowMs);
    this.failures.set(key, list);
    return Math.max(0, this.max - list.length);
  }

  clear(key: string): void {
    this.failures.delete(key);
  }

  private prune(key: string, nowMs: number): number[] {
    const list = (this.failures.get(key) ?? []).filter((t) => nowMs - t < this.windowMs);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }
}
