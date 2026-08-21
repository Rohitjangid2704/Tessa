export function readRequestId(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("requestId" in error)) {
    return null;
  }
  return typeof error.requestId === "string" && error.requestId.length > 0 ? error.requestId : null;
}
