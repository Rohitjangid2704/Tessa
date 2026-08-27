import type { Clock } from "./client";
import {
  coverageLine,
  formatLine,
  interpretEvent,
  parseEnvelope,
  type CoverageSignal,
  type InboxLine,
} from "./inbox-events";
import type { InboxStore } from "./inbox-store";
import type { Redactor } from "./redact";
import { SseParser, type SseFrame } from "./sse";

export const FEEDS = ["findings", "runs", "coverage"] as const;
export type FeedName = (typeof FEEDS)[number];

export const BACKOFF_MIN_MILLISECONDS = 1000;
export const BACKOFF_MAX_MILLISECONDS = 60_000;
export const IDLE_TIMEOUT_MILLISECONDS = 45_000;
export const HEALTHY_CONNECTION_MILLISECONDS = 10_000;
const COVERAGE_REQUEST_TIMEOUT_MILLISECONDS = 20_000;
const SEEN_CAPACITY = 2000;

export type InboxOptions = {
  baseUrl: string;
  token: string;
  store: InboxStore;
  redactor: Redactor;
  clock: Clock;
  log: (message: string, fields?: Record<string, unknown>) => void;
  fetchImpl?: typeof fetch;
  random?: () => number;
  idleTimeoutMilliseconds?: number;
  onLine?: (line: InboxLine, text: string) => void;
};

type ConnectionOutcome = { helloSeen: boolean; healthy: boolean; stop: boolean };

async function drainBody(response: Response): Promise<void> {
  await response.arrayBuffer().catch(() => undefined);
}

export function backoffDelay(attempt: number, random: () => number): number {
  const exponent = Math.max(attempt - 1, 0);
  const ceiling = Math.min(BACKOFF_MAX_MILLISECONDS, BACKOFF_MIN_MILLISECONDS * 2 ** Math.min(exponent, 12));
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

export class Inbox {
  private readonly master = new AbortController();
  private readonly watched = new Set<string>();
  private readonly seen = new Set<string>();
  private readonly baselines = new Map<string, number>();
  private readonly coverageChains = new Map<string, Promise<void>>();
  private readonly loops = new Set<Promise<void>>();
  private revoked = false;
  private readonly fetchImpl: typeof fetch;
  private readonly random: () => number;
  private readonly idleTimeout: number;

  constructor(private readonly options: InboxOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.random = options.random ?? Math.random;
    this.idleTimeout = options.idleTimeoutMilliseconds ?? IDLE_TIMEOUT_MILLISECONDS;
  }

  get watchedTargets(): string[] {
    return [...this.watched];
  }

  get isRevoked(): boolean {
    return this.revoked;
  }

  watch(targetId: string): void {
    if (this.master.signal.aborted || this.revoked || this.watched.has(targetId)) {
      return;
    }
    this.watched.add(targetId);
    for (const feed of FEEDS) {
      const loop = this.readerLoop(feed, targetId).finally(() => this.loops.delete(loop));
      this.loops.add(loop);
    }
  }

  async stop(): Promise<void> {
    this.master.abort();
    await Promise.allSettled([...this.loops]);
  }

  async deliver(line: InboxLine): Promise<boolean> {
    if (this.seen.has(line.dedupeKey)) {
      return false;
    }
    this.seen.add(line.dedupeKey);
    if (this.seen.size > SEEN_CAPACITY) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }
    const text = this.options.redactor.text(formatLine(line));
    try {
      await this.options.store.append([text], new Date(this.options.clock.now()).toISOString());
    } catch (error) {
      this.options.log("inbox write failed", { error: String(error) });
      return false;
    }
    try {
      this.options.onLine?.(line, text);
    } catch (error) {
      this.options.log("inbox listener failed", { error: String(error) });
    }
    return true;
  }

  private async readerLoop(feed: FeedName, targetId: string): Promise<void> {
    let attempt = 0;
    while (!this.master.signal.aborted && !this.revoked) {
      let outcome: ConnectionOutcome;
      try {
        outcome = await this.connect(feed, targetId);
      } catch (error) {
        if (this.master.signal.aborted) {
          return;
        }
        this.options.log("inbox feed connection failed", { feed, error: String(error) });
        outcome = { helloSeen: false, healthy: false, stop: false };
      }
      if (outcome.stop || this.revoked) {
        return;
      }
      attempt = outcome.healthy ? 0 : attempt + 1;
      await this.pause(backoffDelay(attempt, this.random));
    }
  }

  private async pause(milliseconds: number): Promise<void> {
    if (this.master.signal.aborted) {
      return;
    }
    await Promise.race([this.options.clock.sleep(milliseconds, this.master.signal), this.aborted()]);
  }

  private aborted(): Promise<void> {
    return new Promise((resolve) => {
      if (this.master.signal.aborted) {
        resolve();
        return;
      }
      this.master.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  private markRevoked(): void {
    if (this.revoked) {
      return;
    }
    this.revoked = true;
    this.options.log("inbox stopped: the Tessa token was refused; mint a new token and update the plugin setting");
    this.master.abort();
  }

  private async connect(feed: FeedName, targetId: string): Promise<ConnectionOutcome> {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    this.master.signal.addEventListener("abort", forwardAbort, { once: true });
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => controller.abort(), this.idleTimeout);
    };
    const startedAt = this.options.clock.now();
    let helloSeen = false;
    let stop = false;
    let bodyFinished = false;
    try {
      armIdle();
      const response = await this.fetchImpl(
        `${this.options.baseUrl}/api/v1/feeds/${feed}?target_id=${encodeURIComponent(targetId)}`,
        {
          headers: { Authorization: `Bearer ${this.options.token}`, Accept: "text/event-stream" },
          signal: controller.signal,
        },
      );
      if (response.status === 401 || response.status === 403) {
        await drainBody(response);
        bodyFinished = true;
        this.master.signal.removeEventListener("abort", forwardAbort);
        this.markRevoked();
        return { helloSeen, healthy: false, stop: true };
      }
      if (!response.ok || response.body === null) {
        await drainBody(response);
        bodyFinished = true;
        const permanent = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
        if (permanent) {
          this.options.log("inbox feed refused", { feed, status: response.status });
        }
        return { helloSeen, healthy: false, stop: permanent };
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          bodyFinished = true;
          break;
        }
        armIdle();
        for (const frame of parser.push(decoder.decode(chunk.value, { stream: true }))) {
          const verdict = await this.handleFrame(feed, targetId, frame);
          if (verdict === "hello") {
            helloSeen = true;
          } else if (verdict === "revoked") {
            stop = true;
          } else if (verdict === "closing") {
            await reader.cancel().catch(() => undefined);
            bodyFinished = true;
            return {
              helloSeen,
              healthy: helloSeen && this.options.clock.now() - startedAt >= HEALTHY_CONNECTION_MILLISECONDS,
              stop: false,
            };
          }
          if (stop) {
            await reader.cancel().catch(() => undefined);
            bodyFinished = true;
            return { helloSeen, healthy: false, stop: true };
          }
        }
      }
      return {
        helloSeen,
        healthy: helloSeen && this.options.clock.now() - startedAt >= HEALTHY_CONNECTION_MILLISECONDS,
        stop: false,
      };
    } finally {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      this.master.signal.removeEventListener("abort", forwardAbort);
      if (!bodyFinished) {
        controller.abort();
      }
    }
  }

  private async handleFrame(
    feed: FeedName,
    targetId: string,
    frame: SseFrame,
  ): Promise<"hello" | "closing" | "revoked" | "continue"> {
    const envelope = parseEnvelope(frame.data);
    if (envelope === null) {
      return "continue";
    }
    if (envelope.type === "stream.hello") {
      if (feed === "coverage") {
        void this.checkCoverage(targetId, null);
      }
      return "hello";
    }
    if (envelope.type === "stream.closing") {
      if (envelope.payload.reason === "unauthorized") {
        this.markRevoked();
        return "revoked";
      }
      return "closing";
    }
    const interpretation = interpretEvent(envelope, targetId);
    if (interpretation.type === "line") {
      await this.deliver(interpretation.line);
    } else if (interpretation.type === "coverage") {
      void this.checkCoverage(targetId, interpretation.signal);
    }
    return "continue";
  }

  checkCoverage(targetId: string, signal: CoverageSignal | null): Promise<void> {
    const previous = this.coverageChains.get(targetId) ?? Promise.resolve();
    const next = previous.then(() => this.compareNeedsAuthor(targetId, signal)).catch(() => undefined);
    this.coverageChains.set(targetId, next);
    return next;
  }

  private async compareNeedsAuthor(targetId: string, signal: CoverageSignal | null): Promise<void> {
    if (this.master.signal.aborted) {
      return;
    }
    const current = await this.fetchNeedsAuthor(targetId);
    if (current === null) {
      return;
    }
    const before = this.baselines.get(targetId);
    this.baselines.set(targetId, current);
    if (before === undefined || current <= before) {
      return;
    }
    const effective: CoverageSignal = signal ?? {
      targetId,
      planId: null,
      reason: "reconnected",
      dedupeKey: `coverage.updated:${targetId}:grew:${current}`,
    };
    await this.deliver(coverageLine(effective, before, current));
  }

  private async fetchNeedsAuthor(targetId: string): Promise<number | null> {
    try {
      const response = await this.fetchImpl(
        `${this.options.baseUrl}/api/v1/coverage?target_id=${encodeURIComponent(targetId)}`,
        {
          headers: { Authorization: `Bearer ${this.options.token}`, Accept: "application/json" },
          signal: AbortSignal.any([this.master.signal, AbortSignal.timeout(COVERAGE_REQUEST_TIMEOUT_MILLISECONDS)]),
        },
      );
      if (response.status === 404) {
        await drainBody(response);
        return 0;
      }
      if (!response.ok) {
        await drainBody(response);
        return null;
      }
      const body: unknown = await response.json();
      const totals = (body as { totals?: { needs_author?: unknown } } | null)?.totals;
      return typeof totals?.needs_author === "number" ? totals.needs_author : null;
    } catch {
      return null;
    }
  }
}
