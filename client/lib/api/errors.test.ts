import { describe, expect, it } from "vitest";
import { readRequestId } from "@/components/states/request-id";
import {
  ApiError,
  NETWORK_ERROR_CODE,
  describeApiError,
  errorResponseSchema,
  isApiError,
  parseRetryAfterSeconds,
} from "./errors";

function contractBody(overrides: Record<string, unknown> = {}) {
  return {
    error: {
      code: "validation_failed",
      message: "Request validation failed",
      request_id: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11",
      details: [{ loc: ["body", "name"], code: "missing", message: "Field required" }],
      ...overrides,
    },
  };
}

function response(status: number, headers: Record<string, string> = {}) {
  return new Response(null, { status, headers });
}

describe("ApiError.fromResponse", () => {
  it("parses the contract error body", () => {
    const error = ApiError.fromResponse(response(422), contractBody());

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 422,
      code: "validation_failed",
      message: "Request validation failed",
      requestId: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11",
      retryAfterSeconds: null,
    });
    expect(error.details).toEqual([
      { loc: ["body", "name"], code: "missing", message: "Field required" },
    ]);
    expect(errorResponseSchema.safeParse(contractBody()).success).toBe(true);
  });

  it("tolerates FastAPI's default body", () => {
    const error = ApiError.fromResponse(response(404, { "x-request-id": "hdr-1" }), {
      detail: "Not Found",
    });

    expect(error).toMatchObject({
      status: 404,
      code: "not_found",
      message: "Not Found",
      requestId: "hdr-1",
    });
  });

  it("tolerates FastAPI's validation list body", () => {
    const error = ApiError.fromResponse(response(422), {
      detail: [{ loc: ["body"], msg: "Field required", type: "missing" }],
    });

    expect(error).toMatchObject({ code: "validation_failed", message: "Field required" });
  });

  it("tolerates bodies that are not JSON objects", () => {
    const error = ApiError.fromResponse(response(502), "<html>Bad gateway</html>");

    expect(error).toMatchObject({ status: 502, code: "upstream_error" });
    expect(error.message.length).toBeGreaterThan(0);
  });

  it("falls back to generic codes for unknown statuses", () => {
    expect(ApiError.fromResponse(response(418), null).code).toBe("bad_request");
    expect(ApiError.fromResponse(response(599), null).code).toBe("internal_error");
  });

  it("reads Retry-After from a 429", () => {
    const error = ApiError.fromResponse(
      response(429, { "retry-after": "17" }),
      contractBody({ code: "rate_limited", message: "Too many requests" }),
    );

    expect(error).toMatchObject({ status: 429, code: "rate_limited", retryAfterSeconds: 17 });
  });

  it("prefers the body request id and falls back to the header", () => {
    const withBody = ApiError.fromResponse(
      response(500, { "x-request-id": "hdr" }),
      contractBody(),
    );
    const emptyBody = ApiError.fromResponse(
      response(500, { "x-request-id": "hdr" }),
      contractBody({ request_id: "" }),
    );

    expect(withBody.requestId).toBe("0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11");
    expect(emptyBody.requestId).toBe("hdr");
  });

  it("exposes requestId for the error state helper", () => {
    const error = ApiError.fromResponse(response(500), contractBody());

    expect(readRequestId(error)).toBe("0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11");
    expect(readRequestId(new Error("plain"))).toBeNull();
    expect(readRequestId(ApiError.network(new TypeError("x")))).toBeNull();
  });
});

describe("ApiError.dependency", () => {
  it.each(["temporal", "db", "laya", "storage"] as const)(
    "names %s from details[0].code of a 503 dependency_unavailable",
    (dependency) => {
      const error = ApiError.fromResponse(
        response(503),
        contractBody({
          code: "dependency_unavailable",
          message: `${dependency} is down`,
          details: [{ loc: ["dependency"], code: dependency, message: `${dependency} is down` }],
        }),
      );

      expect(error.dependency).toBe(dependency);
    },
  );

  it("is null for other errors and unknown dependency names", () => {
    expect(ApiError.fromResponse(response(500), contractBody()).dependency).toBeNull();
    expect(
      ApiError.fromResponse(
        response(503),
        contractBody({
          code: "dependency_unavailable",
          details: [{ loc: ["dependency"], code: "redis", message: "x" }],
        }),
      ).dependency,
    ).toBeNull();
    expect(
      ApiError.fromResponse(
        response(503),
        contractBody({ code: "dependency_unavailable", details: [] }),
      ).dependency,
    ).toBeNull();
  });
});

describe("ApiError flags", () => {
  it("classifies statuses", () => {
    const client = new ApiError({ status: 404, code: "not_found", message: "x" });
    const server = new ApiError({ status: 503, code: "dependency_unavailable", message: "x" });
    const network = ApiError.network(new TypeError("Failed to fetch"));

    expect([client.isClientError, client.isServerError]).toEqual([true, false]);
    expect([server.isClientError, server.isServerError]).toEqual([false, true]);
    expect(network).toMatchObject({ status: 0, code: NETWORK_ERROR_CODE, isNetworkError: true });
    expect(network.cause).toBeInstanceOf(TypeError);
  });

  it("recognises its own instances", () => {
    expect(isApiError(ApiError.network(null))).toBe(true);
    expect(isApiError(new Error("x"))).toBe(false);
    expect(isApiError({ status: 500 })).toBe(false);
  });
});

describe("parseRetryAfterSeconds", () => {
  it("parses seconds", () => {
    expect(parseRetryAfterSeconds("30")).toBe(30);
    expect(parseRetryAfterSeconds("1.2")).toBe(2);
  });

  it("parses an HTTP date relative to now", () => {
    const now = Date.parse("2026-10-01T10:00:00Z");
    expect(parseRetryAfterSeconds("Thu, 01 Oct 2026 10:00:45 GMT", now)).toBe(45);
    expect(parseRetryAfterSeconds("Thu, 01 Oct 2026 09:59:00 GMT", now)).toBe(0);
  });

  it.each([null, "", "soon", "-5"])("returns null for %j", (value) => {
    expect(parseRetryAfterSeconds(value)).toBeNull();
  });
});

describe("describeApiError", () => {
  it("names the dependency of a 503", () => {
    const error = new ApiError({
      status: 503,
      code: "dependency_unavailable",
      message: "Temporal unavailable",
      details: [{ loc: ["dependency"], code: "temporal", message: "Temporal unavailable" }],
    });

    expect(describeApiError(error)).toBe("Temporal is not running");
  });

  it("describes network failures and rate limits", () => {
    expect(describeApiError(ApiError.network(null))).toContain("Cannot reach");
    expect(
      describeApiError(
        new ApiError({ status: 429, code: "rate_limited", message: "x", retryAfterSeconds: 12 }),
      ),
    ).toBe("Too many requests. Try again in 12 s.");
  });

  it("falls back to the message", () => {
    expect(
      describeApiError(new ApiError({ status: 409, code: "conflict", message: "Taken" })),
    ).toBe("Taken");
    expect(describeApiError(new Error("plain"))).toBe("plain");
    expect(describeApiError("odd")).toBe("Something went wrong");
  });
});
