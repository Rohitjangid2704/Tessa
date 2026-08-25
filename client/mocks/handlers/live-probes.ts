import { http } from "msw";
import { z } from "zod";
import { unauthenticated } from "../factories/errors";
import { newId } from "../factories/ids";
import { requireTarget } from "../stage1/support";
import { CONTROL_OPTIONS, parseControlBody } from "../stage10/labels-probes-control";
import {
  LIVE_PROBE_SCENARIOS,
  LIVE_PROBES_INGEST_KEY,
  liveProbes,
} from "../stage10/live-probes-store";
import { stageEight } from "../stage8/store";
import { api, jsonResponse, type ApiContext } from "./api";

const INGEST_KEY_HEADER = "X-Ingest-Key";
const MAX_BATCH_ITEMS = 1000;
const MAX_CONTROL_ITEMS = 500;
const DEFAULT_CONTROL_ITEMS = 25;

const batchSchema = z.object({
  target_id: z.guid(),
  items: z.array(z.unknown()).min(1).max(MAX_BATCH_ITEMS),
});

const trafficItemSchema = z.object({
  ts: z.string().min(1),
  question: z.string(),
  answer: z.string(),
  meta: z.record(z.string(), z.unknown()),
});

const scenarioBodySchema = z.strictObject({ scenario: z.enum(LIVE_PROBE_SCENARIOS) });

const ingestBodySchema = z.strictObject({
  items: z.number().int().min(1).max(MAX_CONTROL_ITEMS).optional(),
});

function requireIngestKey(context: ApiContext): void {
  const provided = context.request.headers.get(INGEST_KEY_HEADER);
  if (provided === null || provided === "") {
    throw unauthenticated("Missing ingest key");
  }
  if (provided !== LIVE_PROBES_INGEST_KEY) {
    throw unauthenticated("Invalid ingest key");
  }
}

function announceIngest(): void {
  stageEight.bus.publish("dashboard.invalidate", {});
}

async function ingestTraffic(context: ApiContext): Promise<Response> {
  requireIngestKey(context);
  const batch = await parseControlBody(context, batchSchema);
  requireTarget(context, batch.target_id.toLowerCase());
  const accepted = batch.items.filter((item) => trafficItemSchema.safeParse(item).success).length;
  if (accepted > 0) {
    liveProbes.ingest(accepted);
    announceIngest();
  }
  return jsonResponse(
    { batch_id: newId(), accepted, rejected: batch.items.length - accepted },
    { status: 202 },
  );
}

function describeLiveProbes() {
  return {
    scenario: liveProbes.scenario,
    total_ingested: liveProbes.totalIngested,
    live_probes: liveProbes.read(),
  };
}

async function setScenario(context: ApiContext): Promise<Response> {
  const { scenario } = await parseControlBody(context, scenarioBodySchema);
  liveProbes.setScenario(scenario);
  announceIngest();
  return jsonResponse(describeLiveProbes());
}

async function simulateIngest(context: ApiContext): Promise<Response> {
  const { items } = await parseControlBody(context, ingestBodySchema);
  liveProbes.ingest(items ?? DEFAULT_CONTROL_ITEMS);
  announceIngest();
  return jsonResponse(describeLiveProbes());
}

function readLiveProbes(): Response {
  return jsonResponse(describeLiveProbes());
}

export const liveProbesHandlers = [
  http.post("*/api/v1/ingest/traffic", api(ingestTraffic)),
  http.get("*/__mock/stage10/live-probes", api(readLiveProbes, CONTROL_OPTIONS)),
  http.post("*/__mock/stage10/live-probes", api(setScenario, CONTROL_OPTIONS)),
  http.post("*/__mock/stage10/live-probes/ingest", api(simulateIngest, CONTROL_OPTIONS)),
];
