import type { WebsocketMessage } from "@/lib/api/types";

export type MessageDirection = "sent" | "received";

export interface TimelineEntry {
  direction: MessageDirection;
  at_ms: number;
  data: string;
}

const CLOSE_CODE_LABELS: Readonly<Partial<Record<number, string>>> = {
  1000: "Normal closure",
  1001: "Going away",
  1002: "Protocol error",
  1003: "Unsupported data",
  1005: "No status code",
  1006: "Closed abnormally",
  1007: "Invalid payload data",
  1008: "Policy violation",
  1009: "Message too big",
  1010: "Missing extension",
  1011: "Server error",
  1012: "Service restart",
  1013: "Try again later",
  1014: "Bad gateway",
  1015: "TLS handshake failed",
};

const ORDERLY_CLOSE_CODES: readonly number[] = [1000, 1001];

export function toTimelineEntries(
  messages: readonly WebsocketMessage[],
  direction: MessageDirection,
): TimelineEntry[] {
  return messages.map((message) => ({
    direction,
    at_ms: message.at_ms,
    data: message.data,
  }));
}

export function mergeTimeline(
  sent: readonly WebsocketMessage[],
  received: readonly WebsocketMessage[],
): TimelineEntry[] {
  return [...toTimelineEntries(sent, "sent"), ...toTimelineEntries(received, "received")].sort(
    (left, right) => left.at_ms - right.at_ms,
  );
}

export function describeCloseCode(code: number): string {
  return CLOSE_CODE_LABELS[code] ?? "Application close code";
}

export function isOrderlyClose(code: number): boolean {
  return ORDERLY_CLOSE_CODES.includes(code);
}
