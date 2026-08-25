import { http } from "msw";
import { z } from "zod";
import { notFound, validationFailed } from "../factories/errors";
import { parseJsonObject } from "../factories/validation";
import { BodyReader } from "../stage1/body";
import { hashParts, pathUuid, requireIdempotencyKey, withIdempotency } from "../stage1/support";
import { buildFitRead } from "../stage10/calibration-fit-data";
import { startCalibrationFit } from "../stage10/calibration-fit-service";
import { calibrationFits, FIT_BEHAVIOURS } from "../stage10/calibration-fit-store";
import { CONTROL_OPTIONS, parseControlBody } from "../stage10/labels-probes-control";
import { stageTwo } from "../stage2/support";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

const behaviourBodySchema = z.strictObject({ next: z.enum(FIT_BEHAVIOURS) });

async function createFit(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "admin");
  requireIdempotencyKey(context);
  const raw = await context.request.text();
  const reader = new BodyReader(parseJsonObject(raw));
  const targetId = reader.uuid("target_id", { required: false, nullable: true }) ?? null;
  if (reader.details.length > 0) {
    throw validationFailed(reader.details);
  }
  return withIdempotency(
    context,
    user,
    { required: true, requestHash: hashParts("POST", context.url.pathname, targetId ?? "") },
    () => ({
      status: 202,
      body: startCalibrationFit(context, user, targetId?.toLowerCase() ?? null),
    }),
  );
}

async function readFit(context: ApiContext): Promise<Response> {
  await requireUser(context, "admin");
  const runId = pathUuid(context, "run_id");
  const entry = stageTwo(context).findRun(runId);
  if (entry === undefined || entry.run.kind !== "calibration") {
    throw notFound("Calibration run not found");
  }
  return jsonResponse(buildFitRead(entry.run, calibrationFits.find(runId)));
}

function describeFits() {
  return {
    next: calibrationFits.nextBehaviour,
    fits: calibrationFits.all().map((fit) => ({
      run_id: fit.runId,
      behaviour: fit.behaviour,
      held_out_labels: fit.heldOutLabels,
    })),
  };
}

async function setNextBehaviour(context: ApiContext): Promise<Response> {
  const { next } = await parseControlBody(context, behaviourBodySchema);
  calibrationFits.nextBehaviour = next;
  return jsonResponse(describeFits());
}

function readFitControl(): Response {
  return jsonResponse(describeFits());
}

export const calibrationFitHandlers = [
  http.post("*/api/v1/calibration/fit", api(createFit)),
  http.get("*/api/v1/calibration/fit/:run_id", api(readFit)),
  http.get("*/__mock/stage10/calibration-fit", api(readFitControl, CONTROL_OPTIONS)),
  http.post("*/__mock/stage10/calibration-fit", api(setNextBehaviour, CONTROL_OPTIONS)),
];
