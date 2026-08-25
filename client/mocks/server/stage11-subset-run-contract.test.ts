import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PersonalTokenCreated, Run, RunHandle } from "@/lib/api/types";
import type { RunningMockServer } from "@/mocks/server/http";
import { subsetStore } from "@/mocks/stage11/subset-store";
import { mockState } from "@/mocks/state";
import { startMockApi } from "@/tests/utils/mock-api";
import {
  createStage2Client,
  errorOf,
  GRACIE_ID,
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

beforeEach(async () => {
  mockState.reset();
  subsetStore.reset();
  await client.control.clock({ speed: 1000 });
});

async function acceptedScenarioIds(): Promise<string[]> {
  const first = await client.startRun({ plan_id: STAGE_TWO_IDS.plans.smartLog });
  await client.runToEnd(((await first.json()) as RunHandle).run_id);
  return mockState.stageTwo.scenarios
    .filter(
      (entry) =>
        entry.cellKey !== null &&
        entry.scenario.target_id === GRACIE_ID &&
        entry.scenario.status === "accepted",
    )
    .map((entry) => entry.scenario.id);
}

async function start(
  body: Record<string, unknown>,
  key: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return client.send("POST", "/api/v1/runs", body, {
    headers: { "Idempotency-Key": key, ...headers },
  });
}

async function personalToken(): Promise<string> {
  const response = await client.send("POST", "/api/v1/users/me/tokens", { name: "subset" });
  return ((await response.json()) as PersonalTokenCreated).token;
}

describe("POST /runs with scenario_ids", () => {
  it("runs only the named scenarios and records them in the config snapshot", async () => {
    const ids = await acceptedScenarioIds();
    expect(ids.length).toBeGreaterThan(1);
    const response = await client.startRun(
      { target_id: GRACIE_ID, scenario_ids: [ids[0] as string] },
      { key: "subset-run-key-1" },
    );
    expect(response.status, await response.clone().text()).toBe(202);
    const run = await client.runToEnd(((await response.json()) as RunHandle).run_id);
    expect(run.counters.scenarios_total).toBe(1);
    expect((run.config_snapshot as Record<string, unknown>).scenario_ids).toEqual([ids[0]]);
    expect(run.trigger).toBe("manual");
  });

  it("marks a run started with a personal token as an agent run", async () => {
    const ids = await acceptedScenarioIds();
    const token = await personalToken();
    const response = await start(
      { target_id: GRACIE_ID, scenario_ids: [ids[0] as string] },
      "subset-run-key-2",
      { Authorization: `Bearer ${token}` },
    );
    expect(response.status, await response.clone().text()).toBe(202);
    const run = (await client.getRun(((await response.json()) as RunHandle).run_id)) as Run;
    expect(run.trigger).toBe("agent");
  });

  it("answers 422 scenarios_not_runnable with the scenario id as the detail code", async () => {
    const missing = "0198f6f2-4c2a-7d10-9c1e-0000000000aa";
    const response = await client.startRun(
      { target_id: GRACIE_ID, scenario_ids: [missing] },
      { key: "subset-run-key-3" },
    );
    expect(response.status).toBe(422);
    const error = await errorOf(response);
    expect(error.code).toBe("scenarios_not_runnable");
    expect(error.details?.[0]?.code).toBe(missing);
  });

  it("refuses every scenario in the not_runnable variant", async () => {
    const ids = await acceptedScenarioIds();
    subsetStore.variant = "not_runnable";
    const response = await client.startRun(
      { target_id: GRACIE_ID, scenario_ids: [ids[0] as string] },
      { key: "subset-run-key-4" },
    );
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe("scenarios_not_runnable");
  });

  it("is exclusive with plan_id and needs target_id", async () => {
    const both = await client.startRun(
      {
        plan_id: STAGE_TWO_IDS.plans.smartLog,
        target_id: GRACIE_ID,
        scenario_ids: ["0198f6f2-4c2a-7d10-9c1e-0000000000aa"],
      },
      { key: "subset-run-key-5" },
    );
    expect(both.status).toBe(422);
    const noTarget = await client.startRun(
      { scenario_ids: ["0198f6f2-4c2a-7d10-9c1e-0000000000aa"] },
      { key: "subset-run-key-6" },
    );
    expect(noTarget.status).toBe(422);
  });
});
