import { http } from "msw";
import { validationFailed } from "../factories/errors";
import { QueryReader } from "../factories/pagination";
import { requireTarget } from "../stage1/support";
import { buildDashboardSummary } from "../stage8/dashboard-data";
import { buildMutationSummary } from "../stage8/mutation-fixture";
import { stageEight } from "../stage8/store";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

async function readDashboard(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const query = new QueryReader(context.url.searchParams);
  const targetId = query.uuid("target_id");
  query.finish();
  if (targetId !== undefined) {
    requireTarget(context, targetId);
  }
  return jsonResponse(buildDashboardSummary(context, targetId?.toLowerCase()));
}

async function readMutationSummaryFixture(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const query = new QueryReader(context.url.searchParams);
  const targetId = query.uuid("target_id", { required: true });
  query.finish();
  if (targetId === undefined) {
    throw validationFailed([
      { loc: ["query", "target_id"], code: "missing", message: "Field required" },
    ]);
  }
  requireTarget(context, targetId);
  return jsonResponse(buildMutationSummary(targetId.toLowerCase(), stageEight.mutationScenario));
}

export const dashboardHandlers = [http.get("*/api/v1/dashboard", api(readDashboard))];

export const mutationSummaryFixtureHandlers = [
  http.get("*/api/v1/mutation/summary", api(readMutationSummaryFixture)),
];
