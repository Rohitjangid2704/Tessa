const DEFAULT_BUCKET_WIDTH_MS = 0.1;
const DEFAULT_MAX_MS = 200;

export class LatencyHistogram {
  private readonly bucketWidthMs: number;
  private readonly buckets: Uint32Array;
  private total = 0;
  private maxSeenMs = 0;

  constructor(bucketWidthMs: number = DEFAULT_BUCKET_WIDTH_MS, maxMs: number = DEFAULT_MAX_MS) {
    this.bucketWidthMs = bucketWidthMs;
    this.buckets = new Uint32Array(Math.ceil(maxMs / bucketWidthMs) + 1);
  }

  get count(): number {
    return this.total;
  }

  get max(): number {
    return this.maxSeenMs;
  }

  record(valueMs: number): void {
    const safeValue = Number.isFinite(valueMs) ? Math.max(0, valueMs) : 0;
    const index = Math.min(this.buckets.length - 1, Math.floor(safeValue / this.bucketWidthMs));
    this.buckets[index] = (this.buckets[index] ?? 0) + 1;
    this.total += 1;
    this.maxSeenMs = Math.max(this.maxSeenMs, safeValue);
  }

  percentile(fraction: number): number {
    if (this.total === 0) {
      return 0;
    }
    const target = Math.max(1, Math.ceil(this.total * Math.min(1, Math.max(0, fraction))));
    let seen = 0;
    for (let index = 0; index < this.buckets.length; index += 1) {
      seen += this.buckets[index] ?? 0;
      if (seen >= target) {
        const isOverflowBucket = index === this.buckets.length - 1;
        return isOverflowBucket
          ? this.maxSeenMs
          : Math.min((index + 1) * this.bucketWidthMs, this.maxSeenMs);
      }
    }
    return this.maxSeenMs;
  }

  reset(): void {
    this.buckets.fill(0);
    this.total = 0;
    this.maxSeenMs = 0;
  }
}
