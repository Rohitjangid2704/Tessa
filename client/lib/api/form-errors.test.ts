import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { applyApiFieldErrors, fieldMessagesFromApiError } from "./form-errors";

function validationError(details: Array<{ loc: Array<string | number>; message: string }>) {
  return new ApiError({
    status: 422,
    code: "validation_failed",
    message: "Request validation failed",
    details: details.map((detail) => ({ ...detail, code: "x" })),
  });
}

describe("fieldMessagesFromApiError", () => {
  it("maps body fields and keeps the first message per field", () => {
    const result = fieldMessagesFromApiError(
      validationError([
        { loc: ["body", "name"], message: "first" },
        { loc: ["body", "name"], message: "second" },
        { loc: ["body", "app_kind"], message: "kind" },
      ]),
      ["name", "app_kind"],
    );

    expect(result.byField).toEqual({ name: "first", app_kind: "kind" });
    expect(result.unmapped).toEqual([]);
  });

  it("leaves unknown fields, query errors and nested paths unmapped", () => {
    const result = fieldMessagesFromApiError(
      validationError([
        { loc: ["body", "hints"], message: "hints" },
        { loc: ["query", "name"], message: "query" },
        { loc: ["body"], message: "whole body" },
      ]),
      ["name"],
    );

    expect(result.byField).toEqual({});
    expect(result.unmapped).toEqual(["hints", "query", "whole body"]);
  });

  it("maps nothing for an error that is not a 422", () => {
    expect(
      fieldMessagesFromApiError(
        new ApiError({ status: 500, code: "internal_error", message: "x" }),
        ["name"],
      ),
    ).toEqual({ byField: {}, unmapped: [] });
    expect(fieldMessagesFromApiError(new Error("x"), ["name"])).toEqual({
      byField: {},
      unmapped: [],
    });
  });
});

describe("applyApiFieldErrors", () => {
  it("sets a server error on each mapped field and returns no form message", () => {
    const setError = vi.fn();

    const message = applyApiFieldErrors(
      validationError([{ loc: ["body", "name"], message: "Taken" }]),
      setError,
      ["name"],
    );

    expect(setError).toHaveBeenCalledExactlyOnceWith("name", { type: "server", message: "Taken" });
    expect(message).toBeNull();
  });

  it("returns the unmapped messages while still marking the mapped fields", () => {
    const setError = vi.fn();

    const message = applyApiFieldErrors(
      validationError([
        { loc: ["body", "name"], message: "Taken" },
        { loc: ["body", "other"], message: "Odd" },
      ]),
      setError,
      ["name"],
    );

    expect(setError).toHaveBeenCalledOnce();
    expect(message).toBe("Odd");
  });

  it("describes any other error as a form message", () => {
    const setError = vi.fn();

    const message = applyApiFieldErrors(
      new ApiError({ status: 403, code: "role_required", message: "Member role required" }),
      setError,
      ["name"],
    );

    expect(setError).not.toHaveBeenCalled();
    expect(message).toBe("Member role required");
  });
});
