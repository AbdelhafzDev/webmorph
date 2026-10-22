/** Counting semaphore. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    return () => this.release();
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  get inUse(): number {
    return this.active;
  }
}

/** Enforces a minimum spacing between requests to the same host. */
export class HostPacer {
  private readonly nextAllowed = new Map<string, number>();

  constructor(
    private readonly minDelayMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async wait(host: string): Promise<void> {
    if (this.minDelayMs <= 0) return;
    const current = this.now();
    const allowedAt = this.nextAllowed.get(host) ?? 0;
    const start = Math.max(current, allowedAt);
    this.nextAllowed.set(host, start + this.minDelayMs);
    if (start > current) await this.sleep(start - current);
  }

  /** Push the next allowed time for a host further out, e.g. after a 429. */
  backoff(host: string, ms: number): void {
    const until = this.now() + ms;
    const existing = this.nextAllowed.get(host) ?? 0;
    if (until > existing) this.nextAllowed.set(host, until);
  }
}
