import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RunningMockServer } from "@/mocks/server/http";
import { mintArtifactToken } from "@/mocks/stage2/artifacts";
import { mockState } from "@/mocks/state";
import type { Step } from "@/lib/api/types";
import { startMockApi } from "@/tests/utils/mock-api";
import {
  createStage2Client,
  errorOf,
  STAGE_TWO_IDS,
  type Stage2Client,
} from "@/tests/utils/stage2";

let running: RunningMockServer;
let client: Stage2Client;

beforeAll(async () => {
  running = await startMockApi();
  client = createStage2Client(running.baseUrl);
});

afterAll(async () => {
  mockState.reset();
  await running.close();
});

beforeEach(() => {
  mockState.reset();
});

function fetchArtifact(url: string, init?: RequestInit): Promise<Response> {
  return fetch(new URL(url, running.baseUrl), init);
}

async function browserStep(): Promise<Step> {
  const response = await client.get(`/api/v1/steps/${STAGE_TWO_IDS.steps.browserClick}`);
  return (await response.json()) as Step;
}

function artifactOf(step: Step, kind: Step["artifacts"][number]["kind"]) {
  const artifact = step.artifacts.find((candidate) => candidate.kind === kind);
  expect(artifact).toBeDefined();
  return artifact as Step["artifacts"][number];
}

describe("GET /artifacts/{token}", () => {
  it("serves a PNG, a WebM and a ZIP without a bearer token", async () => {
    const step = await browserStep();
    const png = await fetchArtifact(artifactOf(step, "screenshot").url);
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    const pngBytes = new Uint8Array(await png.arrayBuffer());
    expect([...pngBytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.headers.get("content-length")).toBe(String(pngBytes.length));
    expect(png.headers.get("accept-ranges")).toBe("bytes");

    const webm = await fetchArtifact(artifactOf(step, "recording").url);
    expect(webm.headers.get("content-type")).toBe("video/webm");
    expect([...new Uint8Array(await webm.arrayBuffer()).slice(0, 4)]).toEqual([
      0x1a, 0x45, 0xdf, 0xa3,
    ]);

    const zip = await fetchArtifact(artifactOf(step, "trace").url);
    expect(zip.headers.get("content-type")).toBe("application/zip");
    expect(zip.headers.get("content-disposition")).toMatch(
      /^attachment; filename="trace-.+\.zip"$/,
    );
    expect([...new Uint8Array(await zip.arrayBuffer()).slice(0, 2)]).toEqual([0x50, 0x4b]);
  });

  it("reports the real size in ArtifactRef.size_bytes", async () => {
    const step = await browserStep();
    for (const artifact of step.artifacts) {
      const bytes = await (await fetchArtifact(artifact.url)).arrayBuffer();
      expect(bytes.byteLength).toBe(artifact.size_bytes);
    }
  });

  it("serves byte ranges for video seeking and rejects unsatisfiable ranges", async () => {
    const step = await browserStep();
    const { url, size_bytes: size } = artifactOf(step, "recording");
    const partial = await fetchArtifact(url, { headers: { Range: "bytes=0-99" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes 0-99/${size}`);
    expect((await partial.arrayBuffer()).byteLength).toBe(100);
    const open = await fetchArtifact(url, { headers: { Range: `bytes=${size - 10}-` } });
    expect(open.status).toBe(206);
    expect((await open.arrayBuffer()).byteLength).toBe(10);
    const suffix = await fetchArtifact(url, { headers: { Range: "bytes=-20" } });
    expect((await suffix.arrayBuffer()).byteLength).toBe(20);
    const beyond = await fetchArtifact(url, { headers: { Range: `bytes=${size + 5}-` } });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe(`bytes */${size}`);
    expect((await errorOf(beyond)).code).toBe("range_not_satisfiable");
  });

  it("answers 403 for a tampered signature and a malformed token", async () => {
    const step = await browserStep();
    const { url } = artifactOf(step, "screenshot");
    const tampered = url.slice(0, -2) + (url.endsWith("AA") ? "BB" : "AA");
    const bad = await fetchArtifact(tampered);
    expect(bad.status).toBe(403);
    expect((await errorOf(bad)).code).toBe("forbidden");
    const garbage = await fetch(`${running.baseUrl}/api/v1/artifacts/garbage`);
    expect(garbage.status).toBe(403);
  });

  it("answers 403 for an expired signature and 404 for an unknown artifact", async () => {
    const key = mockState.config.wsTicketSigningKey;
    const step = await browserStep();
    const artifact = artifactOf(step, "screenshot");
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expired = mintArtifactToken(artifact.id, nowSeconds - 5, key);
    const expiredResponse = await fetch(`${running.baseUrl}/api/v1/artifacts/${expired}`);
    expect(expiredResponse.status).toBe(403);
    expect((await errorOf(expiredResponse)).message).toMatch(/expired/);
    const unknown = mintArtifactToken("0198f6f2-4c2a-7d10-9c1e-6a4f0d3bffff", nowSeconds + 60, key);
    expect((await fetch(`${running.baseUrl}/api/v1/artifacts/${unknown}`)).status).toBe(404);
  });

  it("signs with a 900 second expiry and allows cross-origin image loads", async () => {
    const step = await browserStep();
    const { url, expires_at: expiresAt } = artifactOf(step, "screenshot");
    const seconds = (Date.parse(expiresAt) - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(895);
    expect(seconds).toBeLessThanOrEqual(900);
    const response = await fetchArtifact(url, { headers: { Origin: "http://localhost:3000" } });
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });

  it("serves an expired url once under the artifact_expired fault, then fresh urls", async () => {
    await client.control.faults({ artifact_expired: true });
    const stale = await browserStep();
    expect(Date.parse(artifactOf(stale, "screenshot").expires_at)).toBeLessThan(Date.now());
    expect((await fetchArtifact(artifactOf(stale, "screenshot").url)).status).toBe(403);
    const fresh = await browserStep();
    expect(Date.parse(artifactOf(fresh, "screenshot").expires_at)).toBeGreaterThan(Date.now());
    expect((await fetchArtifact(artifactOf(fresh, "screenshot").url)).status).toBe(200);
  });

  it("does not consume the artifact_expired fault on steps without artifacts", async () => {
    await client.control.faults({ artifact_expired: true });
    await client.get(`/api/v1/steps/${STAGE_TWO_IDS.steps.httpJson}`);
    const stale = await browserStep();
    expect(Date.parse(artifactOf(stale, "screenshot").expires_at)).toBeLessThan(Date.now());
  });

  it("stops serving artifacts after a reset removes their steps", async () => {
    const step = await browserStep();
    const { url } = artifactOf(step, "screenshot");
    await client.control.seed("empty");
    expect((await fetchArtifact(url)).status).toBe(404);
  });
});
