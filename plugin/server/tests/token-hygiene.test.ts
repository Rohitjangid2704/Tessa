import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BASE_URL, IDS, TOKEN, errorBody } from "./fixtures";
import { createHarness, mswServer, resetSeen } from "./harness";

const API = `${BASE_URL}/api/v1`;

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterAll(() => mswServer.close());
afterEach(() => mswServer.resetHandlers());
beforeEach(() => resetSeen());

describe("the token never reaches a result or a log line", () => {
  it("when the api echoes it in an error, a network failure and an invalid body", async () => {
    mswServer.use(
      http.get(`${API}/users/me`, () =>
        HttpResponse.json(errorBody("token_revoked", `Bearer ${TOKEN} was revoked`), { status: 401 }),
      ),
      http.get(`${API}/targets`, () => HttpResponse.error()),
      http.get(`${API}/findings`, () => new HttpResponse(`<html>${TOKEN}</html>`, { status: 502 })),
      http.get(`${API}/runs/:runId`, () =>
        HttpResponse.json(errorBody("internal", `upstream said ${TOKEN}`, [{ field: "x", message: TOKEN }]), {
          status: 500,
        }),
      ),
    );
    const harness = createHarness();
    const results = [
      await harness.call("whoami"),
      await harness.call("list_targets"),
      await harness.call("list_findings", { target_id: IDS.target }),
      await harness.call("wait_run", { run_id: IDS.run, timeout_s: 1 }),
    ];
    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(result.text).not.toContain(TOKEN);
      expect(result.text).not.toContain(TOKEN.slice(0, 20));
    }
    const logText = JSON.stringify(harness.logs);
    expect(logText).not.toContain(TOKEN);
    expect(logText).not.toContain(TOKEN.slice(0, 20));
  });

  it("when the server starts unconfigured", async () => {
    const harness = createHarness({ config: { problem: "TESSA_TOKEN is not set", token: "" } });
    const result = await harness.call("whoami");
    expect(result.isError).toBe(true);
    expect(JSON.stringify(harness.logs)).not.toContain(TOKEN);
  });
});
