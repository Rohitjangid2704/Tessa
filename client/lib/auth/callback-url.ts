import { z } from "zod";
import { safeCallbackPath } from "./safe-redirect";

export const DEFAULT_CALLBACK_URL = "/";

const REJECTED_CALLBACK_URL = "";
const PARSE_BASE = "http://callback-url.invalid";

export const callbackUrlSchema = z.string().transform((value, context) => {
  const path = safeCallbackPath(value, REJECTED_CALLBACK_URL);
  if (path === REJECTED_CALLBACK_URL) {
    context.addIssue({
      code: "custom",
      message: "The return address must be a path inside Tessa.",
    });
    return z.NEVER;
  }
  return path;
});

export function parseCallbackUrl(value: unknown, fallback = DEFAULT_CALLBACK_URL): string {
  const parsed = callbackUrlSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

export function readCallbackUrl(
  value: string | string[] | undefined,
  fallback = DEFAULT_CALLBACK_URL,
): string {
  return parseCallbackUrl(Array.isArray(value) ? value[0] : value, fallback);
}

export function describeReturnPath(callbackUrl: string): string | null {
  const parsed = parseCallbackUrl(callbackUrl, REJECTED_CALLBACK_URL);
  if (parsed === REJECTED_CALLBACK_URL || parsed === DEFAULT_CALLBACK_URL) {
    return null;
  }
  return new URL(parsed, PARSE_BASE).pathname;
}
