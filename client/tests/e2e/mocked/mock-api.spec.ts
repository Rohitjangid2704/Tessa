import { expect, test } from "@playwright/test";
import { SIGNED_OUT_STORAGE_STATE } from "../helpers/auth-files";
import { apiOrigin } from "../helpers/env";
import { clearMockFaults, readMockState, resetMockApi, setMockFaults } from "../helpers/mock-api";

test.describe("mock API process", () => {
  test.use({ storageState: SIGNED_OUT_STORAGE_STATE });

  test.beforeEach(async ({ request }) => {
    await resetMockApi(request);
  });

  test.afterEach(async ({ request }) => {
    await clearMockFaults(request);
  });

  test("serves liveness and the published schemas", async ({ request }) => {
    const health = await request.get(`${apiOrigin()}/health`);
    expect(await health.json()).toEqual({ status: "ok" });

    const index = await request.get(`${apiOrigin()}/schemas/index.json`);
    const names = ((await index.json()) as { schemas: Array<{ name: string }> }).schemas.map(
      (schema) => schema.name,
    );
    expect(names).toContain("bundle");

    const bundle = await request.get(`${apiOrigin()}/schemas/bundle.v1.json`);
    expect(bundle.status()).toBe(200);
  });

  test("toggles faults over HTTP and reports them back", async ({ request }) => {
    const faults = await setMockFaults(request, { verify_429: true, latency_ms: 10 });
    expect(faults).toMatchObject({ verify_429: true, latency_ms: 10 });

    const state = await readMockState(request);
    expect(state.faults.verify_429).toBe(true);

    await clearMockFaults(request);
    expect((await readMockState(request)).faults.verify_429).toBe(false);
  });

  test("rejects an unknown fault name", async ({ request }) => {
    const response = await request.post(`${apiOrigin()}/__mock/faults`, { data: { nope: true } });
    expect(response.status()).toBe(422);
  });
});
