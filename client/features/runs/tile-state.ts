import type { RunSocketStatus } from "@/lib/ws/socket";

export const STALE_AFTER_MS = 3000;
export const STALE_CHECK_INTERVAL_MS = 1000;

export type TileConnection = "live" | "connecting" | "reconnecting" | "offline";

export type TileState =
  | "ended"
  | "connecting"
  | "reconnecting"
  | "offline"
  | "paused"
  | "waiting"
  | "stale"
  | "live";

export interface TileStateInput {
  ended: boolean;
  connection: TileConnection;
  paused: boolean;
  lastFrameAt: number | null;
  now: number | null;
}

export const DIMMED_TILE_STATES: readonly TileState[] = [
  "connecting",
  "reconnecting",
  "offline",
  "stale",
];

export function tileConnection(status: RunSocketStatus, replayComplete: boolean): TileConnection {
  switch (status) {
    case "live":
      return replayComplete ? "live" : "connecting";
    case "idle":
    case "connecting":
      return "connecting";
    case "reconnecting":
    case "resyncing":
      return "reconnecting";
    case "closed":
    case "failed":
      return "offline";
  }
}

export function deriveTileState({
  ended,
  connection,
  paused,
  lastFrameAt,
  now,
}: TileStateInput): TileState {
  if (ended) {
    return "ended";
  }
  if (connection !== "live") {
    return connection;
  }
  if (paused) {
    return "paused";
  }
  if (lastFrameAt === null) {
    return "waiting";
  }
  if (now !== null && now - lastFrameAt > STALE_AFTER_MS) {
    return "stale";
  }
  return "live";
}
