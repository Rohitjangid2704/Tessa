import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fileFingerprint, textFingerprint, useAttemptKeys } from "./use-attempt-keys";

describe("useAttemptKeys", () => {
  it("keeps the key while the fingerprint stays the same", () => {
    const { result } = renderHook(() => useAttemptKeys());

    const first = result.current.keyFor("same");

    expect(result.current.keyFor("same")).toBe(first);
    expect(first.length).toBeGreaterThanOrEqual(8);
  });

  it("creates a new key for a different fingerprint", () => {
    const { result } = renderHook(() => useAttemptKeys());

    const first = result.current.keyFor("one");
    const second = result.current.keyFor("two");

    expect(second).not.toBe(first);
    expect(result.current.keyFor("two")).toBe(second);
  });

  it("creates a new key for the same fingerprint after the attempt settled", () => {
    const { result } = renderHook(() => useAttemptKeys());

    const first = result.current.keyFor("same");
    result.current.settle();

    expect(result.current.keyFor("same")).not.toBe(first);
  });
});

describe("fingerprints", () => {
  const file = new File(["abc"], "tessa.zip", { lastModified: 1000 });

  it("tells files apart by name, size, modification time, target and note", () => {
    const base = fileFingerprint(file, "t1", "note");

    expect(fileFingerprint(file, "t1", "note")).toBe(base);
    expect(fileFingerprint(file, "t2", "note")).not.toBe(base);
    expect(fileFingerprint(file, "t1", "other")).not.toBe(base);
    expect(
      fileFingerprint(new File(["abcd"], "tessa.zip", { lastModified: 1000 }), "t1", "note"),
    ).not.toBe(base);
    expect(
      fileFingerprint(new File(["abc"], "tessa.zip", { lastModified: 2000 }), "t1", "note"),
    ).not.toBe(base);
  });

  it("ignores surrounding whitespace in the note", () => {
    expect(fileFingerprint(file, "t1", "  note ")).toBe(fileFingerprint(file, "t1", "note"));
  });

  it("tells pasted texts apart", () => {
    expect(textFingerprint("a: 1", "t1", "")).toBe(textFingerprint("a: 1", "t1", ""));
    expect(textFingerprint("a: 1", "t1", "")).not.toBe(textFingerprint("a: 2", "t1", ""));
  });
});
