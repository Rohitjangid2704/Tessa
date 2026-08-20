import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createIdempotencyKey, useIdempotencyKey } from "./idempotency";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("idempotency keys", () => {
  it("creates distinct uuids that satisfy the 8 to 128 character rule", () => {
    const first = createIdempotencyKey();
    const second = createIdempotencyKey();

    expect(first).toMatch(UUID);
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(8);
    expect(first.length).toBeLessThanOrEqual(128);
  });

  it("keeps one key across renders and rotates only on request", () => {
    const { result, rerender } = renderHook(() => useIdempotencyKey());
    const initial = result.current.key;

    rerender();
    expect(result.current.key).toBe(initial);

    act(() => result.current.rotate());
    expect(result.current.key).toMatch(UUID);
    expect(result.current.key).not.toBe(initial);
  });
});
