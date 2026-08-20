import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/errors";
import { PARAMS_ERROR_SCOPE, serverFieldErrors } from "./server-errors";

function validationError(details: Array<{ loc: Array<string | number>; message: string }>) {
  return new ApiError({
    status: 422,
    code: "validation_failed",
    message: "Request validation failed",
    details: details.map((detail) => ({ ...detail, code: "x" })),
  });
}

describe("serverFieldErrors", () => {
  it("maps 422 details under the scope to field names", () => {
    const error = validationError([
      { loc: ["body", "params", "tenant_id"], message: "String should have at least 3 characters" },
      { loc: ["body", "params", "limit"], message: "Input should be greater than or equal to 1" },
    ]);

    expect(serverFieldErrors(error, PARAMS_ERROR_SCOPE)).toEqual({
      byField: {
        tenant_id: "String should have at least 3 characters",
        limit: "Input should be greater than or equal to 1",
      },
      general: [],
    });
  });

  it("keeps the first message per field and joins nested locations with dots", () => {
    const error = validationError([
      { loc: ["body", "params", "a", 0, "b"], message: "first" },
      { loc: ["body", "params", "a", 0, "b"], message: "second" },
    ]);

    expect(serverFieldErrors(error, PARAMS_ERROR_SCOPE).byField).toEqual({ "a.0.b": "first" });
  });

  it("sends details outside the scope and on the scope root to the general list", () => {
    const error = validationError([
      { loc: ["body", "params"], message: "Field required" },
      { loc: ["body", "other"], message: "Extra inputs are not permitted" },
    ]);

    expect(serverFieldErrors(error, PARAMS_ERROR_SCOPE)).toEqual({
      byField: {},
      general: ["Field required", "Extra inputs are not permitted"],
    });
  });

  it("describes anything that is not a 422 with details as one general message", () => {
    const conflict = new ApiError({ status: 409, code: "conflict", message: "Already approved" });
    const empty = new ApiError({ status: 422, code: "validation_failed", message: "Invalid" });

    expect(serverFieldErrors(conflict, PARAMS_ERROR_SCOPE).general).toEqual(["Already approved"]);
    expect(serverFieldErrors(empty, PARAMS_ERROR_SCOPE).general).toEqual(["Invalid"]);
    expect(serverFieldErrors(new Error("boom"), PARAMS_ERROR_SCOPE).general).toEqual(["boom"]);
  });

  it("supports a different scope", () => {
    const error = validationError([{ loc: ["body", "goal", "text"], message: "too short" }]);

    expect(serverFieldErrors(error, ["body", "goal"]).byField).toEqual({ text: "too short" });
  });
});
