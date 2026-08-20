export class KeyedTrailingThrottle {
  private readonly pending = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; task: () => void }
  >();

  constructor(private readonly delayMs: number) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  schedule(key: string, task: () => void): void {
    if (this.pending.has(key)) {
      return;
    }
    const timer = setTimeout(() => {
      this.pending.delete(key);
      task();
    }, this.delayMs);
    this.pending.set(key, { timer, task });
  }

  flush(): void {
    const entries = [...this.pending.values()];
    this.cancel();
    for (const { task } of entries) {
      task();
    }
  }

  cancel(): void {
    for (const { timer } of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
  }
}
