import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/errors";
import type { PersonalToken } from "@/lib/api/types";
import {
  countActiveTokens,
  isTokenLimitError,
  readServerMaxDays,
  toPersonalTokenCreate,
  tokenCreateSchema,
  tokenStateOf,
} from "./schemas";

function apiError(init: ConstructorParameters<typeof ApiError>[0]): ApiError {
  return new ApiError(init);
}

function token(overrides: Partial<PersonalToken> = {}): PersonalToken {
  return {
    id: "id",
    name: "laptop",
    prefix: "ipt_AbCd",
    created_at: "2026-10-01T00:00:00.000Z",
    expires_at: "2026-12-01T00:00:00.000Z",
    last_used_at: null,
    revoked_at: null,
    state: "active",
    user_id: "user-id",
    ...overrides,
  };
}

describe("tokenCreateSchema", () => {
  it.each([
    [{ name: "laptop" }, true],
    [{ name: "laptop", expires_in_days: 1 }, true],
    [{ name: "laptop", expires_in_days: 365 }, true],
    [{ name: "x".repeat(60) }, true],
    [{ name: "" }, false],
    [{ name: "   " }, false],
    [{ name: "x".repeat(61) }, false],
    [{ name: "laptop", expires_in_days: 0 }, false],
    [{ name: "laptop", expires_in_days: 366 }, false],
    [{ name: "laptop", expires_in_days: 1.5 }, false],
    [{ name: "laptop", expires_in_days: Number.NaN }, false],
    [{}, false],
  ])("%j is valid: %s", (input, valid) => {
    expect(tokenCreateSchema.safeParse(input).success).toBe(valid);
  });

  it("trims the name", () => {
    expect(tokenCreateSchema.parse({ name: "  laptop  " }).name).toBe("laptop");
  });

  it("omits an empty expiry from the request body", () => {
    expect(toPersonalTokenCreate({ name: "laptop" })).toEqual({ name: "laptop" });
    expect(toPersonalTokenCreate({ name: "laptop", expires_in_days: 30 })).toEqual({
      name: "laptop",
      expires_in_days: 30,
    });
  });
});

describe("readServerMaxDays", () => {
  const detail = (message: string, field = "expires_in_days") => [
    { loc: ["body", field], code: "less_than_equal", message },
  ];

  it("reads the maximum from the less_than_equal detail of expires_in_days", () => {
    const error = apiError({
      status: 422,
      code: "validation_failed",
      message: "Request validation failed",
      details: detail("Input should be less than or equal to 90"),
    });
    expect(readServerMaxDays(error)).toBe(90);
  });

  it("ignores other fields, other statuses and other errors", () => {
    expect(
      readServerMaxDays(
        apiError({
          status: 422,
          code: "validation_failed",
          message: "x",
          details: detail("Input should be less than or equal to 60", "name"),
        }),
      ),
    ).toBeNull();
    expect(
      readServerMaxDays(
        apiError({
          status: 409,
          code: "token_limit",
          message: "x",
          details: detail("Input should be less than or equal to 90"),
        }),
      ),
    ).toBeNull();
    expect(readServerMaxDays(new Error("boom"))).toBeNull();
  });
});

describe("isTokenLimitError", () => {
  it("matches 409 token_limit only", () => {
    expect(isTokenLimitError(apiError({ status: 409, code: "token_limit", message: "x" }))).toBe(
      true,
    );
    expect(isTokenLimitError(apiError({ status: 409, code: "conflict", message: "x" }))).toBe(
      false,
    );
    expect(isTokenLimitError(apiError({ status: 422, code: "token_limit", message: "x" }))).toBe(
      false,
    );
  });
});

describe("tokenStateOf", () => {
  const now = Date.parse("2026-10-08T00:00:00.000Z");

  it.each([
    [token(), "active"],
    [token({ expires_at: "2026-10-08T00:00:00.000Z" }), "expired"],
    [token({ expires_at: "2026-09-01T00:00:00.000Z" }), "expired"],
    [token({ revoked_at: "2026-10-02T00:00:00.000Z" }), "revoked"],
    [
      token({ revoked_at: "2026-10-02T00:00:00.000Z", expires_at: "2026-09-01T00:00:00.000Z" }),
      "revoked",
    ],
  ])("%j is %s", (value, expected) => {
    expect(tokenStateOf(value, now)).toBe(expected);
  });

  it("counts only active tokens", () => {
    expect(
      countActiveTokens(
        [
          token(),
          token({ revoked_at: "2026-10-02T00:00:00.000Z" }),
          token({ expires_at: "2026-09-01T00:00:00.000Z" }),
        ],
        now,
      ),
    ).toBe(1);
  });
});
