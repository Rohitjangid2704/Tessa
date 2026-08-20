import { useEffect, useState } from "react";
import {
  tileAckMessage,
  tileSubscribeMessage,
  type ClientMessage,
  type TileFramePayload,
  type TileSubscription,
} from "@/features/streams/events";
import { createStore, useStore, type ReadableStore } from "@/lib/store";
import { LatencyHistogram } from "./latency-histogram";

export type TileMode = TileSubscription["mode"];

export type FrameSender = (message: ClientMessage) => boolean;

export type ImageDecoder = (blob: Blob) => Promise<ImageBitmap>;

export interface PaintedFrame {
  frameSeq: number;
  width: number;
  height: number;
  pageUrl: string | null;
}

export interface TileSink {
  paint: (image: ImageBitmap, frame: PaintedFrame) => void;
}

export interface FrameBusStats {
  received: number;
  painted: number;
  dropped: number;
  decodeErrors: number;
  acksSent: number;
  subscribesSent: number;
  bytesReceived: number;
  decodeP50Ms: number;
  decodeP95Ms: number;
  decodeMaxMs: number;
  handlerP95Ms: number;
  handlerMaxMs: number;
  handlerSamples: number;
  paintP95Ms: number;
  attachedTiles: number;
  visibleTiles: number;
  subscribedTiles: number;
  pageVisible: boolean;
  connected: boolean;
}

export interface FrameBusOptions {
  decode?: ImageDecoder;
  scheduleFrame?: (callback: () => void) => () => void;
  now?: () => number;
  statsIntervalMs?: number;
  maxTiles?: number;
  subscribeDebounceMs?: number;
}

export const DEFAULT_MAX_TILES = 12;
export const STATS_INTERVAL_MS = 500;
export const TILE_SUBSCRIBE_DEBOUNCE_MS = 150;
const JPEG_MIME = "image/jpeg";

interface TileEntry {
  sessionId: string;
  order: number;
  sink: TileSink | null;
  visible: boolean;
  mode: TileMode;
  pending: TileFramePayload | null;
  decoding: boolean;
  ready: { bitmap: ImageBitmap; frame: TileFramePayload } | null;
  handledSeq: number;
  ackedSeq: number;
}

export function createInitialFrameBusStats(): FrameBusStats {
  return {
    received: 0,
    painted: 0,
    dropped: 0,
    decodeErrors: 0,
    acksSent: 0,
    subscribesSent: 0,
    bytesReceived: 0,
    decodeP50Ms: 0,
    decodeP95Ms: 0,
    decodeMaxMs: 0,
    handlerP95Ms: 0,
    handlerMaxMs: 0,
    handlerSamples: 0,
    paintP95Ms: 0,
    attachedTiles: 0,
    visibleTiles: 0,
    subscribedTiles: 0,
    pageVisible: true,
    connected: false,
  };
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

const defaultDecoder: ImageDecoder = (blob) => createImageBitmap(blob);

const defaultScheduleFrame = (callback: () => void): (() => void) => {
  const handle = requestAnimationFrame(() => callback());
  return () => cancelAnimationFrame(handle);
};

export class FrameBus implements ReadableStore<FrameBusStats> {
  private readonly tiles = new Map<string, TileEntry>();
  private readonly decode: ImageDecoder;
  private readonly scheduleFrame: (callback: () => void) => () => void;
  private readonly now: () => number;
  private readonly statsIntervalMs: number;
  private readonly subscribeDebounceMs: number;
  private readonly store = createStore<FrameBusStats>(createInitialFrameBusStats());
  private readonly decodeTimes = new LatencyHistogram();
  private readonly handlerTimes = new LatencyHistogram();
  private readonly paintTimes = new LatencyHistogram();
  private counters = {
    received: 0,
    painted: 0,
    dropped: 0,
    decodeErrors: 0,
    acksSent: 0,
    subscribesSent: 0,
    bytesReceived: 0,
  };
  private sender: FrameSender | null = null;
  private maxTiles: number;
  private pageVisible = true;
  private startCount = 0;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private cancelScheduledFrame: (() => void) | null = null;
  private insideFrame = false;
  private ackFlushQueued = false;
  private subscribeQueued = false;
  private subscribeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSubscription: string | null = null;
  private subscribedCount = 0;
  private nextOrder = 0;

  constructor(options: FrameBusOptions = {}) {
    this.decode = options.decode ?? defaultDecoder;
    this.scheduleFrame = options.scheduleFrame ?? defaultScheduleFrame;
    this.now = options.now ?? (() => performance.now());
    this.statsIntervalMs = options.statsIntervalMs ?? STATS_INTERVAL_MS;
    this.maxTiles = options.maxTiles ?? DEFAULT_MAX_TILES;
    this.subscribeDebounceMs = options.subscribeDebounceMs ?? 0;
  }

  readonly getState = (): FrameBusStats => this.store.getState();

  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);

  start(): void {
    this.startCount += 1;
    if (this.startCount > 1) {
      return;
    }
    this.pageVisible = typeof document === "undefined" || document.visibilityState === "visible";
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
    }
    this.statsTimer = setInterval(() => this.flushStats(), this.statsIntervalMs);
    this.queueSubscribe();
    this.flushStats();
  }

  stop(): void {
    this.startCount = Math.max(0, this.startCount - 1);
    if (this.startCount > 0) {
      return;
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    }
    if (this.statsTimer !== null) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.cancelScheduledFrame?.();
    this.cancelScheduledFrame = null;
    this.cancelSubscribeTimer();
    for (const entry of this.tiles.values()) {
      entry.pending = null;
      this.releaseReady(entry);
    }
  }

  setTransport(sender: FrameSender | null): void {
    const wasConnected = this.sender !== null;
    this.sender = sender;
    if (sender !== null && !wasConnected) {
      for (const entry of this.tiles.values()) {
        entry.handledSeq = 0;
        entry.ackedSeq = 0;
      }
      this.lastSubscription = null;
      this.queueSubscribe(true);
    }
    if (sender === null) {
      this.lastSubscription = null;
    }
    this.flushStats();
  }

  setMaxTiles(maxTiles: number): void {
    if (maxTiles === this.maxTiles) {
      return;
    }
    this.maxTiles = maxTiles;
    this.queueSubscribe();
  }

  attach(sessionId: string, sink: TileSink): () => void {
    const entry = this.entryFor(sessionId);
    entry.sink = sink;
    this.queueSubscribe();
    return () => {
      if (entry.sink === sink) {
        entry.sink = null;
        entry.visible = false;
        entry.pending = null;
        this.releaseReady(entry);
        this.queueSubscribe();
      }
    };
  }

  setTileVisible(sessionId: string, visible: boolean): void {
    const entry = this.entryFor(sessionId);
    if (entry.visible === visible) {
      return;
    }
    entry.visible = visible;
    this.queueSubscribe();
  }

  setTileMode(sessionId: string, mode: TileMode): void {
    const entry = this.entryFor(sessionId);
    if (entry.mode === mode) {
      return;
    }
    entry.mode = mode;
    this.queueSubscribe();
  }

  publish(frame: TileFramePayload): void {
    this.counters.received += 1;
    this.counters.bytesReceived += frame.data_b64.length;
    const entry = this.entryFor(frame.browser_session_id);
    if (entry.sink === null || !this.pageVisible || !entry.visible) {
      this.counters.dropped += 1;
      this.markHandled(entry, frame.frame_seq);
      return;
    }
    if (entry.pending !== null) {
      this.counters.dropped += 1;
    }
    entry.pending = frame;
    if (!entry.decoding) {
      this.startDecode(entry);
    }
  }

  recordHandlerSample(durationMs: number): void {
    this.handlerTimes.record(durationMs);
  }

  resubscribe(): void {
    this.lastSubscription = null;
    this.queueSubscribe(true);
  }

  currentSubscription(): TileSubscription[] {
    if (!this.pageVisible) {
      return [];
    }
    return [...this.tiles.values()]
      .filter((entry) => entry.sink !== null && entry.visible)
      .sort((left, right) => left.order - right.order)
      .slice(0, this.maxTiles)
      .map((entry) => ({ browser_session_id: entry.sessionId, mode: entry.mode }));
  }

  flushStats(): void {
    const tiles = [...this.tiles.values()];
    this.store.setState({
      ...this.counters,
      decodeP50Ms: this.decodeTimes.percentile(0.5),
      decodeP95Ms: this.decodeTimes.percentile(0.95),
      decodeMaxMs: this.decodeTimes.max,
      handlerP95Ms: this.handlerTimes.percentile(0.95),
      handlerMaxMs: this.handlerTimes.max,
      handlerSamples: this.handlerTimes.count,
      paintP95Ms: this.paintTimes.percentile(0.95),
      attachedTiles: tiles.filter((entry) => entry.sink !== null).length,
      visibleTiles: tiles.filter((entry) => entry.sink !== null && entry.visible).length,
      subscribedTiles: this.subscribedCount,
      pageVisible: this.pageVisible,
      connected: this.sender !== null,
    });
  }

  resetStats(): void {
    this.counters = {
      received: 0,
      painted: 0,
      dropped: 0,
      decodeErrors: 0,
      acksSent: 0,
      subscribesSent: 0,
      bytesReceived: 0,
    };
    this.decodeTimes.reset();
    this.handlerTimes.reset();
    this.paintTimes.reset();
    this.flushStats();
  }

  private entryFor(sessionId: string): TileEntry {
    const existing = this.tiles.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const created: TileEntry = {
      sessionId,
      order: this.nextOrder,
      sink: null,
      visible: false,
      mode: "grid",
      pending: null,
      decoding: false,
      ready: null,
      handledSeq: 0,
      ackedSeq: 0,
    };
    this.nextOrder += 1;
    this.tiles.set(sessionId, created);
    return created;
  }

  private readonly handleVisibilityChange = (): void => {
    const visible = document.visibilityState === "visible";
    if (visible === this.pageVisible) {
      return;
    }
    this.pageVisible = visible;
    if (!visible) {
      for (const entry of this.tiles.values()) {
        entry.pending = null;
        this.releaseReady(entry);
      }
    }
    this.queueSubscribe(true);
    this.flushStats();
  };

  private releaseReady(entry: TileEntry): void {
    if (entry.ready === null) {
      return;
    }
    const { bitmap, frame } = entry.ready;
    entry.ready = null;
    bitmap.close();
    this.counters.dropped += 1;
    this.markHandled(entry, frame.frame_seq);
  }

  private startDecode(entry: TileEntry): void {
    const frame = entry.pending;
    if (frame === null) {
      return;
    }
    entry.pending = null;
    entry.decoding = true;
    const startedAt = this.now();
    let decoded: Promise<ImageBitmap>;
    try {
      const blob = new Blob([base64ToBytes(frame.data_b64)], { type: JPEG_MIME });
      decoded = this.decode(blob);
    } catch (error) {
      decoded = Promise.reject(error);
    }
    decoded.then(
      (bitmap) => this.finishDecode(entry, frame, bitmap, startedAt),
      () => this.failDecode(entry, frame),
    );
  }

  private finishDecode(
    entry: TileEntry,
    frame: TileFramePayload,
    bitmap: ImageBitmap,
    startedAt: number,
  ): void {
    entry.decoding = false;
    this.decodeTimes.record(this.now() - startedAt);
    if (entry.sink === null || !this.pageVisible) {
      bitmap.close();
      this.counters.dropped += 1;
      this.markHandled(entry, frame.frame_seq);
    } else {
      if (entry.ready !== null) {
        entry.ready.bitmap.close();
        this.counters.dropped += 1;
      }
      entry.ready = { bitmap, frame };
      this.requestFrame();
    }
    if (entry.pending !== null) {
      this.startDecode(entry);
    }
  }

  private failDecode(entry: TileEntry, frame: TileFramePayload): void {
    entry.decoding = false;
    this.counters.decodeErrors += 1;
    this.counters.dropped += 1;
    this.markHandled(entry, frame.frame_seq);
    if (entry.pending !== null) {
      this.startDecode(entry);
    }
  }

  private requestFrame(): void {
    if (this.cancelScheduledFrame !== null) {
      return;
    }
    this.cancelScheduledFrame = this.scheduleFrame(() => this.paintFrame());
  }

  private paintFrame(): void {
    this.cancelScheduledFrame = null;
    this.insideFrame = true;
    for (const entry of this.tiles.values()) {
      const { ready } = entry;
      if (ready === null) {
        continue;
      }
      entry.ready = null;
      if (entry.sink === null) {
        ready.bitmap.close();
        this.counters.dropped += 1;
      } else {
        const startedAt = this.now();
        try {
          entry.sink.paint(ready.bitmap, {
            frameSeq: ready.frame.frame_seq,
            width: ready.frame.width,
            height: ready.frame.height,
            pageUrl: ready.frame.page_url ?? null,
          });
          this.counters.painted += 1;
        } catch {
          this.counters.dropped += 1;
        }
        this.paintTimes.record(this.now() - startedAt);
        ready.bitmap.close();
      }
      this.markHandled(entry, ready.frame.frame_seq);
    }
    this.insideFrame = false;
    this.flushAcks();
  }

  private markHandled(entry: TileEntry, frameSeq: number): void {
    if (frameSeq > entry.handledSeq) {
      entry.handledSeq = frameSeq;
    }
    if (this.insideFrame || this.ackFlushQueued) {
      return;
    }
    this.ackFlushQueued = true;
    queueMicrotask(() => {
      this.ackFlushQueued = false;
      this.flushAcks();
    });
  }

  private flushAcks(): void {
    const send = this.sender;
    if (send === null) {
      return;
    }
    for (const entry of this.tiles.values()) {
      if (entry.handledSeq > entry.ackedSeq) {
        if (send(tileAckMessage(entry.sessionId, entry.handledSeq))) {
          entry.ackedSeq = entry.handledSeq;
          this.counters.acksSent += 1;
        }
      }
    }
  }

  private queueSubscribe(immediate: boolean = false): void {
    if (immediate || this.subscribeDebounceMs <= 0) {
      this.cancelSubscribeTimer();
      this.queueSubscribeMicrotask();
      return;
    }
    if (this.subscribeQueued || this.subscribeTimer !== null) {
      return;
    }
    this.subscribeTimer = setTimeout(() => {
      this.subscribeTimer = null;
      this.sendSubscription();
    }, this.subscribeDebounceMs);
  }

  private queueSubscribeMicrotask(): void {
    if (this.subscribeQueued) {
      return;
    }
    this.subscribeQueued = true;
    queueMicrotask(() => {
      this.subscribeQueued = false;
      this.sendSubscription();
    });
  }

  private cancelSubscribeTimer(): void {
    if (this.subscribeTimer !== null) {
      clearTimeout(this.subscribeTimer);
      this.subscribeTimer = null;
    }
  }

  private sendSubscription(): void {
    const send = this.sender;
    if (send === null) {
      return;
    }
    const subscription = this.currentSubscription();
    const encoded = JSON.stringify(subscription);
    if (encoded === this.lastSubscription) {
      return;
    }
    if (send(tileSubscribeMessage(subscription))) {
      this.lastSubscription = encoded;
      this.subscribedCount = subscription.length;
      this.counters.subscribesSent += 1;
    }
  }
}

export function useFrameBus(options: FrameBusOptions = {}): FrameBus {
  const [bus] = useState(() => new FrameBus(options));
  useEffect(() => {
    bus.start();
    return () => bus.stop();
  }, [bus]);
  return bus;
}

export function useFrameBusTransport(
  bus: FrameBus,
  send: FrameSender,
  connected: boolean,
  maxTiles?: number,
): void {
  useEffect(() => {
    if (maxTiles !== undefined) {
      bus.setMaxTiles(maxTiles);
    }
  }, [bus, maxTiles]);
  useEffect(() => {
    bus.setTransport(connected ? send : null);
    return () => bus.setTransport(null);
  }, [bus, send, connected]);
}

export function useFrameBusStats(bus: FrameBus): FrameBusStats {
  return useStore(bus);
}
