import { http } from "msw";
import { validationFailed } from "../factories/errors";
import { parseJsonObject } from "../factories/validation";
import { faultPatchSchema } from "../server/faults";
import type { ErrorDetail } from "../types";
import { api, jsonResponse, type ApiContext } from "./api";

const CONTROL_OPTIONS = { applyLatency: false };

function readFaults(context: ApiContext): Response {
  return jsonResponse({ faults: context.state.faults.snapshot() });
}

async function patchFaults(context: ApiContext): Promise<Response> {
  const body = parseJsonObject(await context.request.text());
  const parsed = faultPatchSchema.safeParse(body);
  if (!parsed.success) {
    const details: ErrorDetail[] = parsed.error.issues.flatMap((issue) => {
      if (issue.code === "unrecognized_keys") {
        return issue.keys.map((key) => ({
          loc: ["body", key],
          code: "extra_forbidden",
          message: "Extra inputs are not permitted",
        }));
      }
      return [
        {
          loc: ["body", ...issue.path.map((segment) => String(segment))],
          code: issue.code,
          message: issue.message,
        },
      ];
    });
    throw validationFailed(details);
  }
  context.state.faults.apply(parsed.data);
  return jsonResponse({ faults: context.state.faults.snapshot() });
}

function clearFaults(context: ApiContext): Response {
  context.state.faults.reset();
  return jsonResponse({ faults: context.state.faults.snapshot() });
}

function resetState(context: ApiContext): Response {
  context.state.reset();
  return jsonResponse({ faults: context.state.faults.snapshot(), runs: [] });
}

function readState(context: ApiContext): Response {
  const { state } = context;
  return jsonResponse({
    faults: state.faults.snapshot(),
    runs: [...state.runs.values()].map((run) => ({
      run_id: run.id,
      events: run.events.length,
      finished: run.finished,
    })),
    connections: { ...state.connections },
  });
}

export const mockControlHandlers = [
  http.get("*/__mock/faults", api(readFaults, CONTROL_OPTIONS)),
  http.post("*/__mock/faults", api(patchFaults, CONTROL_OPTIONS)),
  http.delete("*/__mock/faults", api(clearFaults, CONTROL_OPTIONS)),
  http.post("*/__mock/reset", api(resetState, CONTROL_OPTIONS)),
  http.get("*/__mock/state", api(readState, CONTROL_OPTIONS)),
];
