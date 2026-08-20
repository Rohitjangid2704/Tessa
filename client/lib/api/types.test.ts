import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { clearToken } from "@/lib/auth/token-client";
import type { components, paths } from "./schema";
import type {
  ApiPaths,
  AttemptTally,
  BudgetState,
  ClockSnapshot,
  ConsoleMessage,
  EvidenceGoldPoint,
  Label,
  ModelSnapshot,
  Plan,
  PlanPreview,
  PlanPreviewSkip,
  PlanSkippedItem,
  RunClock,
  RunConfigModel,
  RunCounters,
  RunHandle,
  ScenarioIssue,
  ScenarioValidationIssue,
  Schemas,
  SettingsRead,
  SseEvent,
  SseStepEvent,
  StepRequest,
  StepResponse,
  StreamEvent,
  BrowserConsoleEntry,
  JudgeGoldPoint,
  BrowserAction,
  BrowserStepRequest,
  RunProgressPayload,
  BudgetUpdatedPayload,
} from "./types";

type GeneratedSchemas = components["schemas"];

describe("generated API types", () => {
  it("exposes the generated paths and schemas unchanged", () => {
    expectTypeOf<ApiPaths>().toEqualTypeOf<paths>();
    expectTypeOf<Schemas>().toEqualTypeOf<GeneratedSchemas>();
    expectTypeOf<ApiPaths["/api/v1/targets"]>().toEqualTypeOf<paths["/api/v1/targets"]>();
    expectTypeOf<Schemas["RunHandle"]>().toEqualTypeOf<GeneratedSchemas["RunHandle"]>();
    expectTypeOf<Plan>().toEqualTypeOf<GeneratedSchemas["Plan"]>();
    expectTypeOf<Label>().toEqualTypeOf<GeneratedSchemas["Label"]>();
  });

  it("keeps the legacy alias names pointing at the generated schemas", () => {
    expectTypeOf<PlanPreviewSkip>().toEqualTypeOf<PlanSkippedItem>();
    expectTypeOf<PlanSkippedItem>().toEqualTypeOf<GeneratedSchemas["PlanSkippedItem"]>();
    expectTypeOf<ScenarioValidationIssue>().toEqualTypeOf<ScenarioIssue>();
    expectTypeOf<RunClock>().toEqualTypeOf<ClockSnapshot>();
    expectTypeOf<RunConfigModel>().toEqualTypeOf<ModelSnapshot>();
    expectTypeOf<SseStepEvent>().toEqualTypeOf<SseEvent>();
    expectTypeOf<BrowserConsoleEntry>().toEqualTypeOf<ConsoleMessage>();
    expectTypeOf<JudgeGoldPoint>().toEqualTypeOf<EvidenceGoldPoint>();
    expectTypeOf<RunProgressPayload>().toEqualTypeOf<RunCounters>();
    expectTypeOf<BudgetUpdatedPayload>().toEqualTypeOf<BudgetState>();
    expectTypeOf<BrowserAction>().toEqualTypeOf<BrowserStepRequest["action"]>();
  });

  it("types the stream event union with every Stage 2 to 4 event", () => {
    expectTypeOf<StreamEvent>().toEqualTypeOf<GeneratedSchemas["StreamEvent"]>();
    expectTypeOf<
      | "run.progress"
      | "budget.updated"
      | "budget.exhausted"
      | "scenario.queued"
      | "scenario.started"
      | "scenario.verdict"
      | "scenario.finished"
      | "step.recorded"
      | "browser_session.started"
      | "browser_session.ended"
      | "tile.frame"
      | "seed.progress"
      | "step.graded"
    >().toExtend<StreamEvent["type"]>();
    expectTypeOf<
      Extract<StreamEvent, { type: "run.progress" }>["payload"]
    >().toEqualTypeOf<RunCounters>();
    expectTypeOf<
      Extract<StreamEvent, { type: "scenario.finished" }>["payload"]["attempts"]
    >().toEqualTypeOf<AttemptTally>();
  });

  it("types the endpoints of phases 2, 3 and 4 through the generated paths", () => {
    expectTypeOf<
      ApiPaths["/api/v1/plans/preview"]["post"]["responses"][200]["content"]["application/json"]
    >().toEqualTypeOf<PlanPreview>();
    expectTypeOf<
      ApiPaths["/api/v1/runs"]["post"]["responses"][202]["content"]["application/json"]
    >().toEqualTypeOf<RunHandle>();
    expectTypeOf<ApiPaths["/api/v1/runs"]["post"]["parameters"]["header"]>().toEqualTypeOf<{
      "Idempotency-Key": string;
    }>();
    expectTypeOf<
      ApiPaths["/api/v1/targets/{target_id}/seeds/reset"]["post"]["responses"][202]["content"]["application/json"]
    >().toEqualTypeOf<RunHandle>();
    expectTypeOf<
      ApiPaths["/api/v1/settings"]["get"]["responses"][200]["content"]["application/json"]
    >().toEqualTypeOf<SettingsRead>();
    expectTypeOf<
      ApiPaths["/api/v1/labels"]["post"]["responses"][200]["content"]["application/json"]
    >().toEqualTypeOf<Label>();
    expectTypeOf<
      ApiPaths["/api/v1/labels"]["post"]["responses"][201]["content"]["application/json"]
    >().toEqualTypeOf<Label>();
  });

  it("narrows step payloads on the inner kind", () => {
    expectTypeOf<Extract<StepRequest, { kind: "browser" }>["action"]>().toEqualTypeOf<
      "navigate" | "click" | "type" | "press" | "wait" | "read" | "assert"
    >();
    expectTypeOf<Extract<StepResponse, { kind: "sse" }>["closed_by"]>().toEqualTypeOf<
      "server" | "limit" | "timeout"
    >();
    expectTypeOf<StepRequest["kind"]>().toEqualTypeOf<"http" | "sse" | "browser">();
    expectTypeOf<StepResponse["kind"]>().toEqualTypeOf<"http" | "sse" | "browser">();
  });
});

type Call = { url: string; method: string; headers: Headers; body: string };

describe("api client", () => {
  const calls: Call[] = [];

  beforeEach(() => {
    calls.length = 0;
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://api.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (typeof input === "string") {
          return Response.json({ token: "token-1", expires_at: "2099-01-01T00:00:00.000Z" });
        }
        const request = new Request(input);
        calls.push({
          url: request.url,
          method: request.method,
          headers: request.headers,
          body: await request.text(),
        });
        return Response.json({ items: [], next_cursor: null, total: null });
      }),
    );
  });

  afterEach(() => {
    clearToken();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function loadApi() {
    vi.resetModules();
    const tokenClient = await import("@/lib/auth/token-client");
    tokenClient.clearToken();
    return (await import("./client")).api;
  }

  it("reaches a phase 2 path with its query and the shared auth middleware", async () => {
    const api = await loadApi();

    const result = await api.GET("/api/v1/runs", {
      params: { query: { target_id: "t1", status: ["running", "queued"], limit: 25 } },
    });

    expect(result.response.ok).toBe(true);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(
      "http://api.test/api/v1/runs?target_id=t1&status=running&status=queued&limit=25",
    );
    expect(calls[0]?.headers.get("Authorization")).toBe("Bearer token-1");
  });

  it("sends the idempotency header and the JSON body of a phase 2 mutation", async () => {
    const api = await loadApi();

    await api.POST("/api/v1/runs", {
      params: { header: { "Idempotency-Key": "key-0001-abcd" } },
      body: { plan_id: "p1", reset_seed: true },
    });

    expect(calls[0]?.url).toBe("http://api.test/api/v1/runs");
    expect(calls[0]?.headers.get("Idempotency-Key")).toBe("key-0001-abcd");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ plan_id: "p1", reset_seed: true });
  });

  it("fills path parameters of phase 3 and phase 4 paths", async () => {
    const api = await loadApi();

    await api.GET("/api/v1/targets/{target_id}/seeds", {
      params: { path: { target_id: "t1" }, query: { limit: 10 } },
    });
    await api.DELETE("/api/v1/settings/secrets/{name}", {
      params: { path: { name: "openai_api_key" } },
    });

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET http://api.test/api/v1/targets/t1/seeds?limit=10",
      "DELETE http://api.test/api/v1/settings/secrets/openai_api_key",
    ]);
  });

  it("still reaches the phase 0 and 1 paths", async () => {
    const api = await loadApi();

    await api.GET("/api/v1/targets");

    expect(calls[0]?.url).toBe("http://api.test/api/v1/targets");
  });
});
