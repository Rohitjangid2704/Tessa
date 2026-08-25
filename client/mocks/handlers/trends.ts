import { http } from "msw";
import { validationFailed } from "../factories/errors";
import { QueryReader } from "../factories/pagination";
import { requireTarget } from "../stage1/support";
import { queryDateTime, stageTwo } from "../stage2/support";
import {
  buildTrendSeries,
  DEFAULT_TREND_RANGE_DAYS,
  TREND_METRICS,
  type TrendRun,
} from "../stage5/trends";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";
import { openFindingsOf } from "./run-stats";

const DAY_MS = 24 * 60 * 60 * 1000;

async function readTrend(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const query = new QueryReader(context.url.searchParams);
  const targetId = query.uuid("target_id", { required: true });
  const metrics = query.enumList("metric", TREND_METRICS);
  if (metrics === undefined) {
    query.details.push({ loc: ["query", "metric"], code: "missing", message: "Field required" });
  }
  const fromInput = queryDateTime(query, "from");
  const toInput = queryDateTime(query, "to");
  const planId = query.uuid("plan_id");
  query.finish();
  const metric = metrics?.[0];
  if (targetId === undefined || metric === undefined) {
    throw validationFailed([{ loc: ["query"], code: "missing", message: "Field required" }]);
  }
  requireTarget(context, targetId);

  const toMs = toInput ?? Date.now();
  const fromMs = fromInput ?? toMs - DEFAULT_TREND_RANGE_DAYS * DAY_MS;
  if (fromMs > toMs) {
    throw validationFailed([
      { loc: ["query", "from"], code: "invalid_range", message: "from must not be after to" },
    ]);
  }

  const store = stageTwo(context);
  const runs = store.runs
    .filter(
      (entry) =>
        entry.run.target_id === targetId.toLowerCase() &&
        entry.run.kind === "suite" &&
        entry.run.status === "completed" &&
        (planId === undefined || entry.run.plan_id === planId.toLowerCase()),
    )
    .map(
      (entry): TrendRun => ({
        entry,
        rows: store.scenariosOfRun(entry.run.id),
        openFindings: openFindingsOf(context, entry.run.id),
      }),
    );
  return jsonResponse(
    buildTrendSeries({ metric, fromMs, toMs, planId: planId?.toLowerCase() ?? null, runs }),
  );
}

export const trendHandlers = [http.get("*/api/v1/trends", api(readTrend))];
