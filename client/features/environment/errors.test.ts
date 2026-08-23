import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/errors";
import { describeHealthFailure, describeSaveFailure } from "./errors";

function apiError(
  status: number,
  code: string,
  message: string,
  details: ConstructorParameters<typeof ApiError>[0]["details"] = [],
) {
  return new ApiError({ status, code, message, requestId: "req-1", details });
}

describe("describeSaveFailure", () => {
  it("maps 422 details on set to the variable they name", () => {
    const failure = describeSaveFailure(
      apiError(422, "validation_failed", "Request validation failed", [
        {
          loc: ["body", "set", "APP_API_URL"],
          code: "invalid_value",
          message: "Needs scheme://host",
        },
        { loc: ["body", "set", "APP_API_URL"], code: "x", message: "ignored duplicate" },
        { loc: ["body", "set", "APP_LIMIT"], code: "invalid_value", message: "Needs a number" },
      ]),
    );

    expect(failure.fieldMessages).toEqual({
      APP_API_URL: "Needs scheme://host",
      APP_LIMIT: "Needs a number",
    });
    expect(failure.message).toBeNull();
  });

  it("keeps a message for details that are not tied to a variable", () => {
    const failure = describeSaveFailure(
      apiError(422, "validation_failed", "Request validation failed", [
        { loc: ["body", "clear", 0], code: "unknown_variable", message: "Not declared" },
        { loc: ["body", "set", "APP_LIMIT"], code: "invalid_value", message: "Needs a number" },
      ]),
    );

    expect(failure.fieldMessages).toEqual({ APP_LIMIT: "Needs a number" });
    expect(failure.message).toBe("Not declared");
  });

  it("falls back to the error message for a 422 without details", () => {
    expect(
      describeSaveFailure(apiError(422, "validation_failed", "Request validation failed")).message,
    ).toBe("Request validation failed");
  });

  it("explains an archived target and a forbidden role", () => {
    expect(describeSaveFailure(apiError(409, "conflict", "Target is archived")).message).toMatch(
      /archived/,
    );
    expect(describeSaveFailure(apiError(403, "role_required", "No")).message).toMatch(
      /member or an admin/,
    );
  });

  it("describes anything else with the shared error text", () => {
    expect(describeSaveFailure(apiError(500, "internal_error", "Boom")).message).toBe("Boom");
    expect(describeSaveFailure(ApiError.network(new Error("offline"))).message).toMatch(
      /Cannot reach the Tessa API/,
    );
    expect(describeSaveFailure(new Error("odd")).message).toBe("odd");
  });
});

describe("describeHealthFailure", () => {
  it("names a timeout and says the stored result is kept", () => {
    const timeout = new DOMException("The operation timed out", "TimeoutError");

    const failure = describeHealthFailure(ApiError.network(timeout));

    expect(failure.title).toBe("Health checks timed out");
    expect(failure.message).toMatch(/60 s/);
    expect(failure.notReady).toBe(false);
  });

  it("does not call an ordinary network failure a timeout", () => {
    const failure = describeHealthFailure(ApiError.network(new TypeError("fetch failed")));

    expect(failure.title).toBe("Health checks failed to run");
    expect(failure.message).toMatch(/Cannot reach the Tessa API/);
  });

  it("flags a target without a valid bundle", () => {
    const failure = describeHealthFailure(apiError(409, "target_not_ready", "Not ready"));

    expect(failure).toMatchObject({ title: "No valid bundle yet", notReady: true });
  });

  it("explains an archived target on any other 409", () => {
    const failure = describeHealthFailure(apiError(409, "conflict", "Archived"));

    expect(failure.message).toMatch(/archived/);
    expect(failure.notReady).toBe(false);
  });

  it("explains a forbidden role and falls back for the rest", () => {
    expect(describeHealthFailure(apiError(403, "role_required", "No")).message).toMatch(
      /member or an admin/,
    );
    expect(describeHealthFailure(apiError(500, "internal_error", "Boom")).message).toBe("Boom");
  });
});
