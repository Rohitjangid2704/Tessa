import { describe, expect, it } from "vitest";
import { mockState } from "@/mocks/handlers";
import { STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { bearer, mintApiToken } from "./tokens";

const API = "http://localhost:8000";

async function authed(): Promise<Record<string, string>> {
  return bearer(await mintApiToken());
}

describe("Stage 1 handlers on the Vitest MSW server", () => {
  it("serves the seeded targets with typed JSON", async () => {
    const response = await fetch(`${API}/api/v1/targets?sort=name`, { headers: await authed() });

    const page = (await response.json()) as { items: Array<{ name: string }> };
    expect(response.status).toBe(200);
    expect(page.items.map((item) => item.name)).toEqual([
      "Billing API",
      "Broken Import",
      "Gracie",
      "Live Shop",
    ]);
  });

  it("answers an upload without a multipart body with the missing-file error", async () => {
    const response = await fetch(`${API}/api/v1/bundles`, {
      method: "POST",
      headers: { ...(await authed()), "Idempotency-Key": "plain-body-key-0001" },
      body: "not multipart",
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { details: [{ loc: ["body", "file"], code: "missing" }] },
    });
  });

  it("pastes a manifest as JSON, the upload path that works in jsdom", async () => {
    const response = await fetch(`${API}/api/v1/bundles/paste`, {
      method: "POST",
      headers: {
        ...(await authed()),
        "Content-Type": "application/json",
        "Idempotency-Key": "paste-in-jsdom-key-01",
      },
      body: JSON.stringify({ target_id: STAGE_ONE_IDS.billing, manifest_yaml: "app: {}\n" }),
    });

    expect(response.status).toBe(201);
    expect(mockState.stageOne.bundlesOf(STAGE_ONE_IDS.billing)).toHaveLength(1);
  });

  it("starts every test from the seeded state", async () => {
    expect(mockState.stageOne.bundlesOf(STAGE_ONE_IDS.billing)).toHaveLength(0);
    expect(mockState.stageOne.targets).toHaveLength(5);
  });

  it("answers the limits and uses the 127.0.0.1 alias like the other handlers", async () => {
    const response = await fetch("http://127.0.0.1:8000/api/v1/limits", {
      headers: await authed(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ bundle_max_zip_bytes: 26_214_400 });
  });
});
