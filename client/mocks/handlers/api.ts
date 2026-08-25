import { timingSafeEqual } from "node:crypto";
import { errors, jwtVerify } from "jose";
import type { HttpResponseResolver, PathParams } from "msw";
import { REQUEST_ID_HEADER, SERVICE_KEY_HEADER } from "../config";
import {
  buildErrorBody,
  internalError,
  MockApiError,
  roleRequired,
  unauthenticated,
} from "../factories/errors";
import { isUuid, newRequestId } from "../factories/ids";
import { secretKey } from "../factories/keys";
import { mockState, type MockState } from "../state";
import type { MockUser, UserRole } from "../types";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const TOKEN_CLOCK_TOLERANCE_SECONDS = 5;
const REQUIRED_TOKEN_CLAIMS = ["exp", "iss", "aud", "sub", "iat"];

const ROLE_RANK: Record<UserRole, number> = { viewer: 0, member: 1, admin: 2 };

export interface ApiContext {
  request: Request;
  params: PathParams;
  url: URL;
  requestId: string;
  state: MockState;
}

export interface BearerExtension {
  recognizes(token: string): boolean;
  resolveUserId(token: string): string;
  afterResponse(request: Request, status: number): void;
}

let bearerExtension: BearerExtension | undefined;

export function installBearerExtension(extension: BearerExtension): void {
  bearerExtension = extension;
}

export type ApiHandler = (context: ApiContext) => Promise<Response> | Response;

export interface JsonResponseInit {
  status?: number;
  headers?: Record<string, string>;
}

export function jsonResponse(body: unknown, init: JsonResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

export function errorResponse(error: MockApiError, requestId: string): Response {
  return jsonResponse(buildErrorBody(error, requestId), {
    status: error.status,
    headers: { ...error.headers, [REQUEST_ID_HEADER]: requestId },
  });
}

export function resolveRequestId(incoming: string | null): string {
  return incoming !== null && REQUEST_ID_PATTERN.test(incoming) ? incoming : newRequestId();
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface ApiOptions {
  applyLatency?: boolean;
}

export function api(handler: ApiHandler, options: ApiOptions = {}): HttpResponseResolver {
  const applyLatency = options.applyLatency ?? true;
  return async ({ request, params }) => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const context: ApiContext = {
      request,
      params,
      url: new URL(request.url),
      requestId,
      state: mockState,
    };
    try {
      if (applyLatency && mockState.faults.latencyMs > 0) {
        await sleep(mockState.faults.latencyMs);
      }
      const response = await handler(context);
      response.headers.set(REQUEST_ID_HEADER, requestId);
      bearerExtension?.afterResponse(request, response.status);
      return response;
    } catch (error) {
      if (error instanceof MockApiError) {
        return errorResponse(error, requestId);
      }
      return errorResponse(internalError(), requestId);
    }
  };
}

export function pathParam(context: ApiContext, name: string): string {
  const value = context.params[name];
  return Array.isArray(value) ? (value[0] ?? "") : String(value ?? "");
}

function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) {
    return null;
  }
  const [scheme, token, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || token === undefined || rest.length > 0) {
    return null;
  }
  return token;
}

async function verifyApiToken(token: string, state: MockState): Promise<string> {
  if (bearerExtension?.recognizes(token)) {
    return bearerExtension.resolveUserId(token);
  }
  const { config } = state;
  try {
    const { payload } = await jwtVerify(token, secretKey(config.apiJwtSecret), {
      algorithms: ["HS256"],
      issuer: config.apiJwtIssuer,
      audience: config.apiJwtAudience,
      clockTolerance: TOKEN_CLOCK_TOLERANCE_SECONDS,
      requiredClaims: REQUIRED_TOKEN_CLAIMS,
    });
    if (typeof payload.sub !== "string" || !isUuid(payload.sub)) {
      throw unauthenticated("Invalid token subject");
    }
    return payload.sub;
  } catch (error) {
    if (error instanceof MockApiError) {
      throw error;
    }
    if (error instanceof errors.JWTExpired) {
      throw unauthenticated("Token expired", "token_expired");
    }
    throw unauthenticated("Invalid token");
  }
}

export async function requireUser(context: ApiContext, minimum: UserRole): Promise<MockUser> {
  const token = extractBearerToken(context.request);
  if (token === null) {
    throw unauthenticated();
  }
  const userId = await verifyApiToken(token, context.state);
  if (context.state.faults.consume("token_expired_once")) {
    throw unauthenticated("Token expired", "token_expired");
  }
  const user = context.state.findUserById(userId);
  if (user === undefined || !user.isActive) {
    throw unauthenticated("Unknown or inactive user");
  }
  if (ROLE_RANK[user.role] < ROLE_RANK[minimum]) {
    throw roleRequired(minimum);
  }
  return user;
}

export function requireServiceKey(context: ApiContext): void {
  const provided = context.request.headers.get(SERVICE_KEY_HEADER);
  const expected = Buffer.from(context.state.config.serviceKey);
  const candidate = Buffer.from(provided ?? "");
  const matches =
    provided !== null &&
    provided !== "" &&
    candidate.length === expected.length &&
    timingSafeEqual(candidate, expected);
  if (!matches) {
    throw unauthenticated("Invalid service key");
  }
}
