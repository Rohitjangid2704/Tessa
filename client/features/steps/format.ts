import { describeAdapterLabel } from "@/features/adapters/registry";

const TIER0_CHECK_LABELS: Readonly<Partial<Record<string, string>>> = {
  status: "Status code",
  schema: "Schema",
  fields: "Fields",
  latency: "Latency",
  tools: "Tools",
  cards: "Cards",
  internal_ids: "Internal ids",
  text_contains: "Text contains",
  text_not_contains: "Text must not contain",
  console: "Console",
  dom_state: "Page state",
};

const SSE_CLOSED_BY_LABELS: Readonly<Partial<Record<string, string>>> = {
  server: "The server ended the stream",
  limit: "The event limit ended the stream",
  timeout: "The stream timed out",
};

const MILLISECONDS_PER_SECOND = 1000;
const SERVER_ERROR_FLOOR = 500;
const CLIENT_ERROR_FLOOR = 400;
const REDIRECT_FLOOR = 300;
const SUCCESS_FLOOR = 200;

export function describeAdapter(adapter: string): string {
  return describeAdapterLabel(adapter);
}

export function describeTier0Check(check: string): string {
  return TIER0_CHECK_LABELS[check] ?? check;
}

export function describeSseClosedBy(closedBy: string): string {
  return SSE_CLOSED_BY_LABELS[closedBy] ?? closedBy;
}

export function formatLatency(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) {
    return "n/a";
  }
  if (milliseconds < MILLISECONDS_PER_SECOND) {
    return `${Math.round(milliseconds)} ms`;
  }
  return `${(milliseconds / MILLISECONDS_PER_SECOND).toFixed(2)} s`;
}

export function formatOffset(milliseconds: number): string {
  return `+${formatLatency(milliseconds)}`;
}

export function describeHttpStatusClass(status: number): string | null {
  if (status >= SERVER_ERROR_FLOOR) {
    return "Server error";
  }
  if (status >= CLIENT_ERROR_FLOOR) {
    return "Client error";
  }
  if (status >= REDIRECT_FLOOR) {
    return "Redirect";
  }
  if (status >= SUCCESS_FLOOR) {
    return "Success";
  }
  return null;
}

export function isHttpErrorStatus(status: number): boolean {
  return status >= CLIENT_ERROR_FLOOR;
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

export function sameId(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
