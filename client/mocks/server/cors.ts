import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import {
  CORS_ALLOWED_HEADERS,
  CORS_ALLOWED_METHODS,
  CORS_EXPOSED_HEADERS,
  CORS_MAX_AGE_SECONDS,
  CORS_SAFELISTED_REQUEST_HEADERS,
} from "../config";

const PREFLIGHT_REJECTION_STATUS = 400;
const PREFLIGHT_OK_STATUS = 200;

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function lowerCaseSet(values: readonly string[]): Set<string> {
  return new Set(values.map((value) => value.toLowerCase()));
}

function respondText(response: ServerResponse, status: number, text: string): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(text);
}

function findPreflightProblem(request: IncomingMessage, originAllowed: boolean): string | null {
  const requestedMethod = singleHeader(request, "access-control-request-method") ?? "";
  const requestedHeaders = (singleHeader(request, "access-control-request-headers") ?? "")
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter((header) => header !== "");
  const allowedHeaders = lowerCaseSet([
    ...CORS_ALLOWED_HEADERS,
    ...CORS_SAFELISTED_REQUEST_HEADERS,
  ]);

  if (!originAllowed) {
    return "Disallowed CORS origin";
  }
  if (!CORS_ALLOWED_METHODS.includes(requestedMethod.toUpperCase())) {
    return "Disallowed CORS method";
  }
  if (requestedHeaders.some((header) => !allowedHeaders.has(header))) {
    return "Disallowed CORS headers";
  }
  return null;
}

export function withCors(
  listener: RequestListener,
  allowedOrigins: () => string[],
): RequestListener {
  return (request, response) => {
    const origin = singleHeader(request, "origin");
    if (origin === undefined) {
      listener(request, response);
      return;
    }

    const originAllowed = allowedOrigins().includes(origin);
    const isPreflight =
      request.method === "OPTIONS" &&
      singleHeader(request, "access-control-request-method") !== undefined;

    if (isPreflight) {
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Methods", CORS_ALLOWED_METHODS.join(", "));
      response.setHeader("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS.join(", "));
      response.setHeader("Access-Control-Max-Age", String(CORS_MAX_AGE_SECONDS));
      if (originAllowed) {
        response.setHeader("Access-Control-Allow-Origin", origin);
      }
      const problem = findPreflightProblem(request, originAllowed);
      respondText(
        response,
        problem === null ? PREFLIGHT_OK_STATUS : PREFLIGHT_REJECTION_STATUS,
        problem ?? "OK",
      );
      return;
    }

    response.setHeader("Access-Control-Expose-Headers", CORS_EXPOSED_HEADERS.join(", "));
    if (originAllowed) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
    listener(request, response);
  };
}
