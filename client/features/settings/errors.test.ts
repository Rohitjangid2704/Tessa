import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/errors";
import {
  ADMIN_ONLY_MESSAGE,
  describeSaveFailure,
  describeSecretFailure,
  describeTestRequestFailure,
} from "./errors";
import { leafId } from "./schemas";

function validationError(details: Array<{ loc: Array<string | number>; message: string }>) {
  return new ApiError({
    status: 422,
    code: "validation_failed",
    message: "Request validation failed",
    requestId: "req-1",
    details: details.map((detail) => ({ ...detail, code: "invalid" })),
  });
}

describe("describeSaveFailure", () => {
  it("maps a detail to the leaf it names and keeps the rest as a message", () => {
    const failure = describeSaveFailure(
      validationError([
        { loc: ["body", "models", "judge", "effort"], message: "Input should be 'low' or 'high'" },
        { loc: ["body", "models", "attack", "model"], message: "Model names use letters" },
      ]),
      "models",
    );

    expect(failure.fieldMessages).toEqual({
      [leafId("models", "judge", "effort")]: "Input should be 'low' or 'high'",
      [leafId("models", "attack", "model")]: "Model names use letters",
    });
    expect(failure.message).toBeNull();
  });

  it("keeps the first message for a leaf and maps flat groups", () => {
    const failure = describeSaveFailure(
      validationError([
        { loc: ["body", "thresholds", "probe_confidence"], message: "first" },
        { loc: ["body", "thresholds", "probe_confidence"], message: "second" },
      ]),
      "thresholds",
    );

    expect(failure.fieldMessages).toEqual({ thresholds__probe_confidence: "first" });
  });

  it("shows what it cannot place on a leaf of this section as one message", () => {
    const failure = describeSaveFailure(
      validationError([
        { loc: ["body", "thresholds", "probe_confidence"], message: "too high" },
        { loc: ["body", "budgets", "max_concurrency"], message: "elsewhere" },
        { loc: ["body"], message: "Field required" },
        { loc: ["body", "thresholds", "colour"], message: "unknown" },
      ]),
      "thresholds",
    );

    expect(failure.fieldMessages).toEqual({ thresholds__probe_confidence: "too high" });
    expect(failure.message).toBe("elsewhere Field required unknown");
  });

  it("falls back to the error message when a 422 has no details", () => {
    expect(describeSaveFailure(validationError([]), "budgets").message).toBe(
      "Request validation failed",
    );
  });

  it("says only admins can save on a 403 and describes anything else", () => {
    const forbidden = new ApiError({
      status: 403,
      code: "role_required",
      message: "Requires admin",
    });
    const server = new ApiError({ status: 500, code: "internal_error", message: "Boom" });

    expect(describeSaveFailure(forbidden, "models").message).toBe(ADMIN_ONLY_MESSAGE);
    expect(describeSaveFailure(server, "models").message).toBe("Boom");
    expect(describeSaveFailure(new Error("offline"), "models").message).toEqual(expect.any(String));
  });
});

describe("describeSecretFailure and describeTestRequestFailure", () => {
  it("shows the server's first detail for a 422 and the admin message for a 403", () => {
    expect(
      describeSecretFailure(validationError([{ loc: ["body", "value"], message: "Too short" }])),
    ).toBe("Too short");
    expect(
      describeSecretFailure(new ApiError({ status: 403, code: "forbidden", message: "No" })),
    ).toBe(ADMIN_ONLY_MESSAGE);
    expect(
      describeTestRequestFailure(new ApiError({ status: 403, code: "forbidden", message: "No" })),
    ).toBe(ADMIN_ONLY_MESSAGE);
    expect(
      describeTestRequestFailure(
        new ApiError({ status: 500, code: "internal_error", message: "Boom" }),
      ),
    ).toBe("Boom");
  });
});
