import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BASE_URL, IDS, run } from "./fixtures";
import { createHarness, mswServer, requestsTo, resetSeen } from "./harness";

const API = `${BASE_URL}/api/v1`;

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterAll(() => mswServer.close());
afterEach(() => mswServer.resetHandlers());
beforeEach(() => resetSeen());

function serveStatuses(statuses: string[]) {
  let index = 0;
  mswServer.use(
    http.get(`${API}/runs/:runId`, () => {
      const status = statuses[Math.min(index, statuses.length - 1)] as string;
      index += 1;
      return HttpResponse.json(run(status));
    }),
  );
}

describe("wait_run", () => {
  it.each(["completed", "failed", "canceled", "budget_exceeded"])("stops at %s", async (terminal) => {
    serveStatuses(["queued", "running", terminal]);
    const harness = createHarness();
    const result = await harness.call("wait_run", { run_id: IDS.run });
    expect(result.body.timed_out).toBe(false);
    expect(result.body.run.status).toBe(terminal);
    expect(result.body.run.terminal).toBe(true);
    expect(requestsTo("GET", `/runs/${IDS.run}`)).toHaveLength(3);
    expect(harness.clock.sleeps).toEqual([1000, 1000]);
  });

  it("returns at once when the run is already terminal", async () => {
    serveStatuses(["completed"]);
    const harness = createHarness();
    const result = await harness.call("wait_run", { run_id: IDS.run });
    expect(result.body.timed_out).toBe(false);
    expect(harness.clock.sleeps).toEqual([]);
  });

  it.each(["queued", "planning", "seeding", "running", "canceling"])(
    "keeps polling while the run is %s",
    async (status) => {
      serveStatuses([status, status, "completed"]);
      const harness = createHarness();
      const result = await harness.call("wait_run", { run_id: IDS.run });
      expect(result.body.run.status).toBe("completed");
    },
  );

  it("times out with the last state", async () => {
    serveStatuses(["running"]);
    const harness = createHarness();
    const result = await harness.call("wait_run", { run_id: IDS.run, timeout_s: 5 });
    expect(result.isError).toBe(false);
    expect(result.body.timed_out).toBe(true);
    expect(result.body.run.status).toBe("running");
    expect(result.body.waited_ms).toBe(5000);
    expect(harness.clock.sleeps).toEqual([1000, 1000, 1000, 1000, 1000]);
  });

  it("polls every second for 30 seconds and every 5 seconds after", async () => {
    serveStatuses(["running"]);
    const harness = createHarness();
    const result = await harness.call("wait_run", { run_id: IDS.run, timeout_s: 42 });
    expect(result.body.timed_out).toBe(true);
    const fast = harness.clock.sleeps.filter((value) => value === 1000);
    const slow = harness.clock.sleeps.filter((value) => value === 5000);
    expect(fast).toHaveLength(30);
    expect(slow).toHaveLength(2);
    expect(harness.clock.sleeps.at(-1)).toBe(2000);
    expect(harness.clock.elapsed()).toBe(42_000);
  });

  it("refuses a timeout above 1800 seconds", async () => {
    const harness = createHarness();
    const result = await harness.call("wait_run", { run_id: IDS.run, timeout_s: 1801 });
    expect(result.isError).toBe(true);
    expect(result.body.error.code).toBe("invalid_arguments");
  });

  it("accepts the maximum timeout", async () => {
    serveStatuses(["completed"]);
    const harness = createHarness();
    const result = await harness.call("wait_run", { run_id: IDS.run, timeout_s: 1800 });
    expect(result.isError).toBe(false);
  });

  it("surfaces an api error while polling", async () => {
    mswServer.use(
      http.get(`${API}/runs/:runId`, () =>
        HttpResponse.json({ error: { code: "not_found", message: "no run", request_id: "r1", details: [] } }, { status: 404 }),
      ),
    );
    const harness = createHarness();
    const result = await harness.call("wait_run", { run_id: IDS.run });
    expect(result.isError).toBe(true);
    expect(result.body.error.code).toBe("not_found");
  });
});
