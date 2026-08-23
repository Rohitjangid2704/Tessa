import type { AuditEvent } from "@/lib/api/types";

export const DETAIL_TEXT_MAX_CHARS = 400;

function valueText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value) ?? "";
}

export function requestIdOf(event: Pick<AuditEvent, "detail">): string | null {
  const candidate: unknown = event.detail["request_id"];
  return typeof candidate === "string" && candidate !== "" ? candidate : null;
}

export function describeDetail(event: Pick<AuditEvent, "detail">): string {
  const text = Object.entries(event.detail)
    .filter(([key]) => key !== "request_id")
    .map(([key, value]) => `${key}: ${valueText(value)}`)
    .join(", ");
  return text.length > DETAIL_TEXT_MAX_CHARS ? `${text.slice(0, DETAIL_TEXT_MAX_CHARS)}...` : text;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
