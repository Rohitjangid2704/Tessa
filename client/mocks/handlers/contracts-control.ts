import { http } from "msw";
import { z } from "zod";
import { validationFailed } from "../factories/errors";
import { parseJsonObject } from "../factories/validation";
import { CONTRACT_BEHAVIORS } from "../stage9/contracts-data";
import { ensureContractSeed } from "../stage9/contracts-seed";
import { contractStore } from "../stage9/contracts-store";
import type { ErrorDetail } from "../types";
import { api, jsonResponse, type ApiContext } from "./api";

const CONTROL_OPTIONS = { applyLatency: false };

const behaviorBodySchema = z.strictObject({
  next_check: z.enum(CONTRACT_BEHAVIORS),
});

function toDetails(error: z.ZodError): ErrorDetail[] {
  return error.issues.flatMap((issue) => {
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
}

function describeContracts(context: ApiContext) {
  ensureContractSeed(context.state);
  return {
    next_check: contractStore.nextBehavior,
    checks: contractStore.entries.map((entry) => ({
      id: entry.id,
      run_id: entry.runId,
      items: entry.items.length,
      revealed: entry.revealed,
    })),
  };
}

async function setNextCheck(context: ApiContext): Promise<Response> {
  const parsed = behaviorBodySchema.safeParse(parseJsonObject(await context.request.text()));
  if (!parsed.success) {
    throw validationFailed(toDetails(parsed.error));
  }
  ensureContractSeed(context.state);
  contractStore.nextBehavior = parsed.data.next_check;
  return jsonResponse(describeContracts(context));
}

function readContractState(context: ApiContext): Response {
  return jsonResponse(describeContracts(context));
}

export const contractControlHandlers = [
  http.get("*/__mock/stage9/contracts", api(readContractState, CONTROL_OPTIONS)),
  http.post("*/__mock/stage9/contracts", api(setNextCheck, CONTROL_OPTIONS)),
];
