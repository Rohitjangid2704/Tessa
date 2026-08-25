import { encode } from "jpeg-js";
import {
  clientMessageSchema,
  type ClientMessage,
  type StreamLimits,
  type TileSubscription,
} from "@/features/streams/events";
import { newId } from "../factories/ids";
import type { EventEnvelope } from "../types";

export const FRAME_WIDTH = 640;
export const FRAME_HEIGHT = 400;
export const FRAME_JPEG_QUALITY = 60;
export const FRAME_NOISE_AMPLITUDE = 72;
export const FRAME_VARIANTS = 4;
export const DEFAULT_FRAME_SESSIONS = 12;
export const MAX_UNACKED_FRAMES_PER_TILE = 2;
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

const HEADER_HEIGHT = 36;
const DIGIT_SCALE = 14;
const DIGIT_THICKNESS = 4;
const SEGMENT_PATTERNS: Record<string, readonly number[]> = {
  "0": [1, 1, 1, 0, 1, 1, 1],
  "1": [0, 0, 1, 0, 0, 1, 0],
  "2": [1, 0, 1, 1, 1, 0, 1],
  "3": [1, 0, 1, 1, 0, 1, 1],
  "4": [0, 1, 1, 1, 0, 1, 0],
  "5": [1, 1, 0, 1, 0, 1, 1],
  "6": [1, 1, 0, 1, 1, 1, 1],
  "7": [1, 0, 1, 0, 0, 1, 0],
  "8": [1, 1, 1, 1, 1, 1, 1],
  "9": [1, 1, 1, 1, 0, 1, 1],
};

export interface FrameSession {
  id: string;
  index: number;
  title: string;
  pageUrl?: string;
  active?: boolean;
}

export interface RenderedFrame {
  dataBase64: string;
  width: number;
  height: number;
  byteLength: number;
}

export interface FramePool {
  frameFor: (sessionIndex: number, frameSeq: number) => RenderedFrame;
  readonly variants: number;
}

export function createFrameSessions(count: number): FrameSession[] {
  return Array.from({ length: count }, (_, index) => ({
    id: newId(),
    index,
    title: `Spike session ${index + 1}`,
  }));
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = (hue % 360) / 60;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  const [red, green, blue] =
    sector < 1
      ? [chroma, x, 0]
      : sector < 2
        ? [x, chroma, 0]
        : sector < 3
          ? [0, chroma, x]
          : sector < 4
            ? [0, x, chroma]
            : sector < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const offset = lightness - chroma / 2;
  return [
    Math.round((red + offset) * 255),
    Math.round((green + offset) * 255),
    Math.round((blue + offset) * 255),
  ];
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4_294_967_296;
  };
}

function fillRect(
  data: Uint8Array,
  rect: { x: number; y: number; width: number; height: number },
  color: readonly [number, number, number],
): void {
  const right = Math.min(FRAME_WIDTH, rect.x + rect.width);
  const bottom = Math.min(FRAME_HEIGHT, rect.y + rect.height);
  for (let y = Math.max(0, rect.y); y < bottom; y += 1) {
    for (let x = Math.max(0, rect.x); x < right; x += 1) {
      const offset = (y * FRAME_WIDTH + x) * 4;
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
    }
  }
}

function drawDigit(data: Uint8Array, digit: string, originX: number, originY: number): void {
  const pattern = SEGMENT_PATTERNS[digit] ?? SEGMENT_PATTERNS["8"] ?? [];
  const width = DIGIT_SCALE * 3;
  const height = DIGIT_SCALE * 5;
  const half = Math.round(height / 2);
  const rectangles = [
    { x: originX, y: originY, width, height: DIGIT_THICKNESS },
    { x: originX, y: originY, width: DIGIT_THICKNESS, height: half },
    { x: originX + width - DIGIT_THICKNESS, y: originY, width: DIGIT_THICKNESS, height: half },
    { x: originX, y: originY + half, width, height: DIGIT_THICKNESS },
    { x: originX, y: originY + half, width: DIGIT_THICKNESS, height: half },
    {
      x: originX + width - DIGIT_THICKNESS,
      y: originY + half,
      width: DIGIT_THICKNESS,
      height: half,
    },
    { x: originX, y: originY + height - DIGIT_THICKNESS, width, height: DIGIT_THICKNESS },
  ];
  rectangles.forEach((rectangle, index) => {
    if (pattern[index] === 1) {
      fillRect(data, rectangle, [255, 255, 255]);
    }
  });
}

export function renderFrame(
  sessionIndex: number,
  variant: number,
  variants: number = FRAME_VARIANTS,
): RenderedFrame {
  const data = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
  const hue = (sessionIndex * 47) % 360;
  const top = hslToRgb(hue, 0.55, 0.32);
  const bottom = hslToRgb((hue + 40) % 360, 0.6, 0.5);
  const random = createRandom(sessionIndex * 7919 + variant * 104_729 + 17);

  for (let y = 0; y < FRAME_HEIGHT; y += 1) {
    const mix = y / FRAME_HEIGHT;
    const red = top[0] + (bottom[0] - top[0]) * mix;
    const green = top[1] + (bottom[1] - top[1]) * mix;
    const blue = top[2] + (bottom[2] - top[2]) * mix;
    for (let x = 0; x < FRAME_WIDTH; x += 1) {
      const noise = (random() - 0.5) * FRAME_NOISE_AMPLITUDE;
      const offset = (y * FRAME_WIDTH + x) * 4;
      data[offset] = Math.max(0, Math.min(255, red + noise));
      data[offset + 1] = Math.max(0, Math.min(255, green + noise));
      data[offset + 2] = Math.max(0, Math.min(255, blue + noise));
      data[offset + 3] = 255;
    }
  }

  fillRect(data, { x: 0, y: 0, width: FRAME_WIDTH, height: HEADER_HEIGHT }, [24, 24, 28]);
  const label = String(sessionIndex + 1);
  const digitWidth = DIGIT_SCALE * 3 + DIGIT_SCALE;
  [...label].forEach((digit, position) => {
    drawDigit(data, digit, 40 + position * digitWidth, 110);
  });
  const travel = FRAME_WIDTH - 160;
  const barX = 40 + Math.round((variant / Math.max(1, variants - 1)) * travel);
  fillRect(data, { x: barX, y: 300, width: 80, height: 40 }, [255, 255, 255]);
  fillRect(data, { x: 0, y: FRAME_HEIGHT - 8, width: FRAME_WIDTH, height: 8 }, [24, 24, 28]);

  const encoded = encode({ data, width: FRAME_WIDTH, height: FRAME_HEIGHT }, FRAME_JPEG_QUALITY);
  return {
    dataBase64: Buffer.from(encoded.data).toString("base64"),
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    byteLength: encoded.data.length,
  };
}

const poolCache = new Map<string, FramePool>();

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function getFramePool(
  sessionCount: number,
  variants: number = FRAME_VARIANTS,
): Promise<FramePool> {
  const key = `${sessionCount}:${variants}`;
  const cached = poolCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const frames: RenderedFrame[][] = [];
  for (let sessionIndex = 0; sessionIndex < sessionCount; sessionIndex += 1) {
    const rendered: RenderedFrame[] = [];
    for (let variant = 0; variant < variants; variant += 1) {
      rendered.push(renderFrame(sessionIndex, variant, variants));
      await yieldToEventLoop();
    }
    frames.push(rendered);
  }
  const pool: FramePool = {
    variants,
    frameFor: (sessionIndex, frameSeq) => {
      const forSession = frames[sessionIndex % frames.length];
      const frame = forSession?.[frameSeq % variants];
      if (frame === undefined) {
        throw new Error(`no frame rendered for session ${sessionIndex}`);
      }
      return frame;
    },
  };
  poolCache.set(key, pool);
  return pool;
}

export type TileMode = TileSubscription["mode"];

export interface FrameStats {
  sent: number;
  skippedWindowFull: number;
  skippedBackpressure: number;
  subscribes: number;
  acks: number;
  bytesSent: number;
}

interface TileState {
  session: FrameSession;
  mode: TileMode | null;
  produced: number;
  unacked: number[];
  timer: ReturnType<typeof setTimeout> | null;
  nextDueAt: number;
}

export interface FrameSink {
  send: (envelope: EventEnvelope) => void;
  bufferedAmount: () => number;
}

export interface FrameStreamerOptions {
  runId: string;
  sessions: readonly FrameSession[];
  pool: FramePool;
  limits: StreamLimits;
  sink: FrameSink;
}

export type FrameMessageResult = "handled" | "invalid";

export class FrameStreamer {
  readonly stats: FrameStats = {
    sent: 0,
    skippedWindowFull: 0,
    skippedBackpressure: 0,
    subscribes: 0,
    acks: 0,
    bytesSent: 0,
  };
  private readonly options: FrameStreamerOptions;
  private readonly tiles = new Map<string, TileState>();
  private stopped = false;
  private clientSubscribed = false;

  constructor(options: FrameStreamerOptions) {
    this.options = options;
    for (const session of options.sessions) {
      this.tiles.set(session.id, this.createTile(session));
    }
  }

  get runId(): string {
    return this.options.runId;
  }

  addSession(session: FrameSession): void {
    if (this.stopped || this.tiles.has(session.id)) {
      return;
    }
    const tile = this.createTile(session);
    this.tiles.set(session.id, tile);
    if (!this.clientSubscribed && this.subscribedCount() < this.options.limits.max_tiles) {
      tile.mode = "grid";
      tile.nextDueAt = Date.now();
      this.schedule(tile);
    }
  }

  removeSession(id: string): void {
    const tile = this.tiles.get(id);
    if (tile === undefined) {
      return;
    }
    this.clearTimer(tile);
    this.tiles.delete(id);
  }

  private createTile(session: FrameSession): TileState {
    return { session, mode: null, produced: 0, unacked: [], timer: null, nextDueAt: 0 };
  }

  private subscribedCount(): number {
    let count = 0;
    for (const tile of this.tiles.values()) {
      if (tile.mode !== null) {
        count += 1;
      }
    }
    return count;
  }

  get subscribedModes(): Record<string, TileMode> {
    const modes: Record<string, TileMode> = {};
    for (const [id, tile] of this.tiles) {
      if (tile.mode !== null) {
        modes[id] = tile.mode;
      }
    }
    return modes;
  }

  start(): void {
    const defaults = [...this.tiles.keys()]
      .slice(0, this.options.limits.max_tiles)
      .map((id) => ({ browser_session_id: id, mode: "grid" as const }));
    this.applySubscription(defaults);
  }

  stop(): void {
    this.stopped = true;
    for (const tile of this.tiles.values()) {
      this.clearTimer(tile);
    }
  }

  handle(message: ClientMessage | { type: string; payload: unknown }): FrameMessageResult {
    const parsed = clientMessageSchema.safeParse(message);
    if (!parsed.success) {
      return "invalid";
    }
    if (parsed.data.type === "tile.subscribe") {
      const { tiles } = parsed.data.payload;
      if (tiles.length > this.options.limits.max_tiles) {
        return "invalid";
      }
      this.stats.subscribes += 1;
      this.clientSubscribed = true;
      this.applySubscription(tiles);
      return "handled";
    }
    this.stats.acks += 1;
    const tile = this.tiles.get(parsed.data.payload.browser_session_id);
    if (tile !== undefined) {
      const acknowledged = parsed.data.payload.frame_seq;
      tile.unacked = tile.unacked.filter((frameSeq) => frameSeq > acknowledged);
    }
    return "handled";
  }

  private periodMs(mode: TileMode): number {
    const quality = mode === "grid" ? this.options.limits.grid : this.options.limits.focus;
    return 1000 / Math.max(1, quality.max_fps);
  }

  private clearTimer(tile: TileState): void {
    if (tile.timer !== null) {
      clearTimeout(tile.timer);
      tile.timer = null;
    }
  }

  private applySubscription(subscriptions: readonly TileSubscription[]): void {
    if (this.stopped) {
      return;
    }
    const wanted = new Map<string, TileMode>();
    for (const subscription of subscriptions) {
      if (this.tiles.has(subscription.browser_session_id)) {
        wanted.set(subscription.browser_session_id, subscription.mode);
      }
    }
    const total = this.tiles.size;
    for (const [id, tile] of this.tiles) {
      const mode = wanted.get(id) ?? null;
      if (mode === tile.mode) {
        continue;
      }
      this.clearTimer(tile);
      tile.mode = mode;
      if (mode === null) {
        continue;
      }
      const period = this.periodMs(mode);
      const stagger = (tile.session.index / Math.max(1, total)) * period;
      tile.nextDueAt = Date.now() + stagger;
      this.schedule(tile);
    }
  }

  private schedule(tile: TileState): void {
    tile.timer = setTimeout(() => this.tick(tile), Math.max(0, tile.nextDueAt - Date.now()));
  }

  private tick(tile: TileState): void {
    tile.timer = null;
    if (this.stopped || tile.mode === null) {
      return;
    }
    tile.produced += 1;
    this.emit(tile);
    tile.nextDueAt += this.periodMs(tile.mode);
    this.schedule(tile);
  }

  private emit(tile: TileState): void {
    if (tile.unacked.length >= MAX_UNACKED_FRAMES_PER_TILE) {
      this.stats.skippedWindowFull += 1;
      return;
    }
    if (this.options.sink.bufferedAmount() > MAX_BUFFERED_BYTES) {
      this.stats.skippedBackpressure += 1;
      return;
    }
    const frame = this.options.pool.frameFor(tile.session.index, tile.produced);
    const capturedAt = new Date().toISOString();
    tile.unacked.push(tile.produced);
    this.stats.sent += 1;
    this.stats.bytesSent += frame.byteLength;
    this.options.sink.send({
      type: "tile.frame",
      run_id: this.options.runId,
      seq: null,
      ts: capturedAt,
      payload: {
        browser_session_id: tile.session.id,
        frame_seq: tile.produced,
        mime: "image/jpeg",
        width: frame.width,
        height: frame.height,
        data_b64: frame.dataBase64,
        page_url: tile.session.pageUrl ?? `http://app.test/${tile.session.index + 1}`,
        captured_at: capturedAt,
      },
    });
  }
}
