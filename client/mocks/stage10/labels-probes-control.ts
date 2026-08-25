import { z } from "zod";
import { validationFailed } from "../factories/errors";
import { parseJsonObject } from "../factories/validation";
import type { ApiContext } from "../handlers/api";
import type { ErrorDetail } from "../types";

export const CONTROL_OPTIONS = { applyLatency: false };

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

export async function parseControlBody<Schema extends z.ZodType>(
  context: ApiContext,
  schema: Schema,
): Promise<z.output<Schema>> {
  const parsed = schema.safeParse(parseJsonObject(await context.request.text()));
  if (!parsed.success) {
    throw validationFailed(toDetails(parsed.error));
  }
  return parsed.data;
}
