import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadResolver() {
  vi.resetModules();
  return (await import("./artifact-url")).resolveArtifactUrl;
}

describe("resolveArtifactUrl", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:8000");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves the signed relative url against the API origin", async () => {
    const resolveArtifactUrl = await loadResolver();

    expect(resolveArtifactUrl("/api/v1/artifacts/abc.def")).toBe(
      "http://localhost:8000/api/v1/artifacts/abc.def",
    );
  });

  it("keeps the origin of the API and drops any path of its base url", async () => {
    const resolveArtifactUrl = await loadResolver();

    expect(resolveArtifactUrl("/api/v1/artifacts/abc.def", "https://api.example.test/base")).toBe(
      "https://api.example.test/api/v1/artifacts/abc.def",
    );
  });

  it("passes an absolute http url through", async () => {
    const resolveArtifactUrl = await loadResolver();

    expect(resolveArtifactUrl("https://cdn.example.test/a.png")).toBe(
      "https://cdn.example.test/a.png",
    );
  });

  it("refuses a url with another scheme", async () => {
    const resolveArtifactUrl = await loadResolver();

    expect(resolveArtifactUrl("javascript:alert(1)")).toBeNull();
    expect(resolveArtifactUrl("data:text/html,x")).toBeNull();
  });
});
