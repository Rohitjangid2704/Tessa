import { describe, expect, it } from "vitest";
import { mockState } from "@/mocks/handlers";
import { STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { STAGE_TWO_IDS } from "@/mocks/stage2/seed-ids";
import type { Plan, PlanPreview, RunHandle, RunSummaryPage, Step } from "@/lib/api/types";
import { bearer, mintApiToken } from "./tokens";

const API = "http://localhost:8000";

async function authed(): Promise<Record<string, string>> {
  return bearer(await mintApiToken());
}

function planBody(): Record<string, unknown> {
  return {
    target_id: STAGE_ONE_IDS.gracie,
    saved: false,
    selection: {
      feature_ids: ["smart_log.read.open_maintenance"],
      area_ids: [],
      roles: ["guest"],
      interface_mode: "both",
      depth: "smoke",
      k: 1,
    },
  };
}

describe("Stage 2 handlers on the Vitest MSW server", () => {
  it("serves the plan preview", async () => {
    const response = await fetch(`${API}/api/v1/plans/preview`, {
      method: "POST",
      headers: { ...(await authed()), "Content-Type": "application/json" },
      body: JSON.stringify(planBody()),
    });
    expect(response.status).toBe(200);
    const preview = (await response.json()) as PlanPreview;
    expect(preview.cells_total).toBe(2);
  });

  it("lists the seeded runs and saved plans", async () => {
    const runs = (await (
      await fetch(`${API}/api/v1/runs?include_total=true`, { headers: await authed() })
    ).json()) as RunSummaryPage;
    expect(runs.total).toBe(6);
    const plans = (await (
      await fetch(`${API}/api/v1/plans?saved=true`, { headers: await authed() })
    ).json()) as { items: Plan[] };
    expect(plans.items.map((plan) => plan.id)).toContain(STAGE_TWO_IDS.plans.smartLog);
  });

  it("starts a run that stays queued under the real clock and is reset with the state", async () => {
    mockState.stageTwo.controls.holds.push({ phase: "created", runId: null });
    const response = await fetch(`${API}/api/v1/runs`, {
      method: "POST",
      headers: {
        ...(await authed()),
        "Content-Type": "application/json",
        "Idempotency-Key": "unit-run-key-001",
      },
      body: JSON.stringify({ plan: planBody() }),
    });
    expect(response.status).toBe(202);
    const handle = (await response.json()) as RunHandle;
    expect(handle.status).toBe("queued");
    expect(mockState.stageTwo.findRun(handle.run_id)?.record.events).toHaveLength(1);
  });

  it("starts every test from the seeded Stage 2 state", async () => {
    expect(mockState.stageTwo.runs).toHaveLength(6);
    expect(mockState.stageTwo.controls.holds).toEqual([]);
  });

  it("serves step fixtures and their media bytes", async () => {
    const step = (await (
      await fetch(`${API}/api/v1/steps/${STAGE_TWO_IDS.steps.browserNavigate}`, {
        headers: await authed(),
      })
    ).json()) as Step;
    const screenshot = step.artifacts.find((artifact) => artifact.kind === "screenshot");
    expect(screenshot?.url).toMatch(/^http:\/\/localhost:8000\/api\/v1\/artifacts\//);
    const media = await fetch(screenshot?.url ?? "");
    expect(media.status).toBe(200);
    expect(media.headers.get("content-type")).toBe("image/png");
    expect((await media.arrayBuffer()).byteLength).toBe(screenshot?.size_bytes);
  });
});
