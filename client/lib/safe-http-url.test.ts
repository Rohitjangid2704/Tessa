import { describe, expect, it } from "vitest";
import { safeHttpUrl } from "./safe-http-url";

describe("safeHttpUrl", () => {
  it("passes http and https links through in normalised form", () => {
    expect(safeHttpUrl("http://localhost:8233/namespaces/default/workflows/run-1")).toBe(
      "http://localhost:8233/namespaces/default/workflows/run-1",
    );
    expect(safeHttpUrl("https://temporal.example.test")).toBe("https://temporal.example.test/");
  });

  it.each(["javascript:alert(1)", "data:text/html,x", "ftp://example.test", "/relative", "nope"])(
    "rejects %s",
    (value) => {
      expect(safeHttpUrl(value)).toBeNull();
    },
  );

  it("treats a missing value as no link", () => {
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
  });
});
