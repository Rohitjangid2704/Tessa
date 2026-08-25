import "../server/grading-hooks";
import { http } from "msw";
import { notFound } from "../factories/errors";
import { pathUuid } from "../stage1/support";
import { stageTwo } from "../stage2/support";
import { toStep } from "../stage2/views";
import { withHumanVerdict } from "../stage4/human-verdict";
import { stageFour } from "../stage4/support";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

async function readStep(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const record = stageTwo(context).findStep(pathUuid(context, "step_id"));
  if (record === undefined) {
    throw notFound("Step not found");
  }
  const expired = record.defs.length > 0 && context.state.faults.consume("artifact_expired");
  const step = toStep(record, {
    key: context.state.config.wsTicketSigningKey,
    nowMs: Date.now(),
    expired,
  });
  return jsonResponse(withHumanVerdict(step, stageFour(context).labels));
}

export const stepHandlers = [http.get("*/api/v1/steps/:step_id", api(readStep))];
