import { http } from "msw";
import { QueryReader } from "../factories/pagination";
import { requireTarget } from "../stage1/support";
import { buildCalibrationReport } from "../stage8/calibration-data";
import { stageEight } from "../stage8/store";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

async function readCalibration(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const query = new QueryReader(context.url.searchParams);
  const targetId = query.uuid("target_id");
  query.finish();
  if (targetId !== undefined) {
    requireTarget(context, targetId);
  }
  return jsonResponse(
    buildCalibrationReport(
      targetId?.toLowerCase(),
      stageEight.calibrationScenario,
      new Date().toISOString(),
    ),
  );
}

export const calibrationHandlers = [http.get("*/api/v1/calibration", api(readCalibration))];
