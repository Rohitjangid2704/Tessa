import { http } from "msw";
import { VERIFY_FAULT_RETRY_AFTER_SECONDS } from "../config";
import { MockApiError, rateLimited } from "../factories/errors";
import { toAuthUser } from "../factories/users";
import { FieldValidator, parseJsonObject } from "../factories/validation";
import { api, jsonResponse, requireServiceKey, requireUser, type ApiContext } from "./api";

const CLIENT_ADDRESS_HEADER = "x-forwarded-for";
const UNKNOWN_CLIENT_ADDRESS = "unknown";

function loginAttemptKey(context: ApiContext, email: string): string {
  const address = context.request.headers.get(CLIENT_ADDRESS_HEADER) ?? UNKNOWN_CLIENT_ADDRESS;
  return `${email.trim().toLowerCase()}|${address}`;
}

async function verifyCredentials(context: ApiContext): Promise<Response> {
  requireServiceKey(context);
  const body = parseJsonObject(await context.request.text());
  const validator = new FieldValidator("body");
  const { email, password } = validator.finish({
    email: validator.requiredString(body, "email", { min: 3, max: 320 }),
    password: validator.requiredString(body, "password", { min: 1, max: 1024 }),
  });

  const { state } = context;
  if (state.faults.verify429) {
    throw rateLimited(VERIFY_FAULT_RETRY_AFTER_SECONDS);
  }
  const attemptKey = loginAttemptKey(context, email);
  const retryAfter = state.loginRetryAfterSeconds(attemptKey);
  if (retryAfter !== null) {
    throw rateLimited(retryAfter);
  }
  const user = state.findUserByEmail(email);
  if (user === undefined || user.password !== password || !user.isActive) {
    state.recordLoginFailure(attemptKey);
    throw new MockApiError(401, "invalid_credentials", "Invalid email or password");
  }
  state.clearLoginFailures(attemptKey);
  return jsonResponse(toAuthUser(user));
}

async function readCurrentUser(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "viewer");
  return jsonResponse(toAuthUser(user));
}

export const authHandlers = [
  http.post("*/api/v1/auth/credentials/verify", api(verifyCredentials)),
  http.get("*/api/v1/users/me", api(readCurrentUser)),
];
