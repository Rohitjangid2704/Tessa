import { describe, expect, it } from "vitest";
import { safeCallbackPath } from "./safe-redirect";

describe("safeCallbackPath", () => {
  it.each([
    ["/", "/"],
    ["/runs", "/runs"],
    [
      "/runs/0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11?tab=events",
      "/runs/0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11?tab=events",
    ],
    ["/catalog?target_id=abc#top", "/catalog?target_id=abc#top"],
    ["/targets/new", "/targets/new"],
  ])("keeps the same-origin path %s", (input, expected) => {
    expect(safeCallbackPath(input)).toBe(expected);
  });

  it.each([
    ["an absolute http URL", "http://evil.example/steal"],
    ["an absolute https URL", "https://evil.example"],
    ["a protocol-relative URL", "//evil.example/path"],
    ["a protocol-relative URL with a backslash", "/\\evil.example"],
    ["a backslash path", "\\evil.example"],
    ["a javascript URL", "javascript:alert(1)"],
    ["a data URL", "data:text/html;base64,AAAA"],
    ["a path starting with a tab that normalises to a host", "/\t/evil.example"],
    ["a path with a newline", "/runs\nSet-Cookie: a=b"],
    ["a path with a null byte", "/runs\u0000"],
    ["a relative path without a leading slash", "runs"],
    ["a bare host", "evil.example"],
    ["the login page", "/login"],
    ["the login page with a query", "/login?callbackUrl=/runs"],
    ["a path below the login page", "/login/extra"],
  ])("falls back for %s", (_label, input) => {
    expect(safeCallbackPath(input)).toBe("/");
  });

  it("does not treat paths that merely start with login as the login page", () => {
    expect(safeCallbackPath("/loginhistory")).toBe("/loginhistory");
  });

  it.each([null, undefined, ""])("falls back for %j", (input) => {
    expect(safeCallbackPath(input)).toBe("/");
  });

  it("falls back for oversized values", () => {
    expect(safeCallbackPath(`/${"a".repeat(3000)}`)).toBe("/");
  });

  it("uses the supplied fallback", () => {
    expect(safeCallbackPath("//evil.example", "/runs")).toBe("/runs");
    expect(safeCallbackPath(null, "")).toBe("");
  });

  it("normalises dot segments inside the origin", () => {
    expect(safeCallbackPath("/a/../runs")).toBe("/runs");
  });

  it("never escapes the origin through encoded slashes", () => {
    const result = safeCallbackPath("/%2F%2Fevil.example");
    expect(result.startsWith("/")).toBe(true);
    expect(result.startsWith("//")).toBe(false);
  });
});
