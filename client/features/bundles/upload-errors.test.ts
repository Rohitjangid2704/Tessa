import { describe, expect, it } from "vitest";
import { ApiError, TOKEN_UNAVAILABLE_CODE, type ApiErrorDetail } from "@/lib/api/errors";
import {
  ARCHIVE_REJECTION_CODES,
  describeUploadFailure,
  TOO_LARGE_CODES,
  type UploadFailureKind,
} from "./upload-errors";

function failure(
  status: number,
  code: string,
  details: ApiErrorDetail[] = [],
  message = "server message",
  extra: { requestId?: string; retryAfterSeconds?: number } = {},
): ApiError {
  return new ApiError({
    status,
    code,
    message,
    details,
    requestId: extra.requestId ?? "req-1",
    retryAfterSeconds: extra.retryAfterSeconds,
  });
}

function detail(code: string, loc: Array<string | number>, message = code): ApiErrorDetail {
  return { loc, code, message };
}

describe("413 payload_too_large", () => {
  it.each(TOO_LARGE_CODES)("maps the detail code %s to a size failure", (code) => {
    const path = code === "entry_too_large" ? "seeds/dump.sql" : undefined;
    const loc = path === undefined ? ["file"] : ["file", path];
    const result = describeUploadFailure(
      failure(413, "payload_too_large", [detail(code, loc)], "Too big: 100 bytes"),
    );

    expect(result.kind).toBe("too_large");
    expect(result.code).toBe(code);
    expect(result.retryable).toBe(false);
    expect(result.title).not.toBe("");
    expect(result.nextStep).not.toBeNull();
    expect(result.message).toContain("Too big: 100 bytes");
    if (path !== undefined) {
      expect(result.message).toContain(path);
    }
  });

  it("gives each size code its own title", () => {
    const titles = TOO_LARGE_CODES.map(
      (code) =>
        describeUploadFailure(failure(413, "payload_too_large", [detail(code, ["file"])])).title,
    );

    expect(new Set(titles).size).toBe(titles.length);
  });

  it("falls back to a generic size failure when the body has no detail", () => {
    const result = describeUploadFailure(failure(413, "payload_too_large"));

    expect(result.kind).toBe("too_large");
    expect(result.code).toBe("payload_too_large");
    expect(result.title).toBe("The upload is larger than the server accepts");
  });
});

describe("415 unsupported_media_type", () => {
  it("asks for a zip", () => {
    const result = describeUploadFailure(
      failure(415, "unsupported_media_type", [detail("unsupported_media_type", ["form", "file"])]),
    );

    expect(result.kind).toBe("unsupported_media");
    expect(result.nextStep).toContain(".zip");
  });
});

describe("409 conflicts", () => {
  it("maps target_token_mismatch", () => {
    const result = describeUploadFailure(
      failure(409, "target_token_mismatch", [
        detail("target_token_mismatch", ["form", "target_id"]),
      ]),
    );

    expect(result.kind).toBe("token_mismatch");
    expect(result.title).toBe("This bundle belongs to a different target");
    expect(result.retryable).toBe(false);
  });

  it("maps idempotency_conflict to a fresh upload", () => {
    const result = describeUploadFailure(failure(409, "idempotency_conflict"));

    expect(result.kind).toBe("idempotency_conflict");
    expect(result.nextStep).toContain("Choose the file again");
  });

  it("maps a conflict on an archived target", () => {
    const result = describeUploadFailure(failure(409, "conflict", [], "This target is archived"));

    expect(result.kind).toBe("target_archived");
    expect(result.message).toBe("This target is archived");
  });
});

describe("422 target_token_unknown", () => {
  it("tells where the token comes from", () => {
    const result = describeUploadFailure(
      failure(422, "target_token_unknown", [
        detail("target_token_unknown", ["manifest", "target_token"]),
      ]),
    );

    expect(result.kind).toBe("token_unknown");
    expect(result.nextStep).toContain("Discovery or Fix-up prompt");
  });
});

describe("422 bundle_contains_secret", () => {
  const details = [
    detail("aws_access_key", ["file", "env.template", 7], "AWS_ACCESS_KEY_ID=[REDACTED]"),
    detail("dsn_password", ["file", "seeds/reset.sql", 12], "psql postgresql://u:[REDACTED]@db/x"),
  ];

  it("lists file, line, pattern and the redacted excerpt for every finding", () => {
    const result = describeUploadFailure(failure(422, "bundle_contains_secret", details));

    expect(result.kind).toBe("secret_found");
    expect(result.findings).toEqual([
      {
        file: "env.template",
        line: 7,
        pattern: "aws_access_key",
        excerpt: "AWS_ACCESS_KEY_ID=[REDACTED]",
      },
      {
        file: "seeds/reset.sql",
        line: 12,
        pattern: "dsn_password",
        excerpt: "psql postgresql://u:[REDACTED]@db/x",
      },
    ]);
  });

  it("states that nothing was stored and how to fix it", () => {
    const result = describeUploadFailure(failure(422, "bundle_contains_secret", details));

    expect(result.nextStep).toContain("Nothing was stored");
    expect(result.nextStep).toContain("${NAME}");
    expect(result.retryable).toBe(false);
  });

  it("copes with a finding that has no line", () => {
    const result = describeUploadFailure(
      failure(422, "bundle_contains_secret", [detail("jwt", ["file", "README.md"], "[REDACTED]")]),
    );

    expect(result.findings).toEqual([
      { file: "README.md", line: null, pattern: "jwt", excerpt: "[REDACTED]" },
    ]);
  });
});

describe("422 validation_failed", () => {
  it.each(ARCHIVE_REJECTION_CODES)("maps the archive code %s", (code) => {
    const result = describeUploadFailure(
      failure(422, "validation_failed", [detail(code, ["file", "x/y.txt"], "problem text")]),
    );

    expect(result.kind).toBe("archive_rejected");
    expect(result.code).toBe(code);
    expect(result.nextStep).not.toBeNull();
    expect(result.problems).toEqual([{ code, message: "problem text", path: "x/y.txt" }]);
  });

  it("gives each archive code its own title", () => {
    const titles = ARCHIVE_REJECTION_CODES.map(
      (code) =>
        describeUploadFailure(failure(422, "validation_failed", [detail(code, ["file"])])).title,
    );

    expect(new Set(titles).size).toBe(titles.length);
  });

  it("keeps unknown validation problems as a rejection with the problem list", () => {
    const result = describeUploadFailure(
      failure(422, "validation_failed", [
        detail("string_too_long", ["body", "note"], "String should have at most 500 characters"),
      ]),
    );

    expect(result.kind).toBe("rejected");
    expect(result.problems).toEqual([
      {
        code: "string_too_long",
        message: "String should have at most 500 characters",
        path: null,
      },
    ]);
  });
});

describe("other statuses", () => {
  const cases: Array<[string, ApiError, UploadFailureKind, boolean]> = [
    ["403 role_required", failure(403, "role_required"), "forbidden", false],
    ["404 not_found", failure(404, "not_found"), "target_missing", false],
    [
      "429 rate_limited",
      failure(429, "rate_limited", [], "slow", { retryAfterSeconds: 30 }),
      "rate_limited",
      true,
    ],
    ["500 internal_error", failure(500, "internal_error"), "unavailable", true],
    ["502 upstream_error", failure(502, "upstream_error"), "unavailable", true],
    ["400 bad_request", failure(400, "bad_request"), "unknown", false],
  ];

  it.each(cases)("%s", (_name, error, kind, retryable) => {
    const result = describeUploadFailure(error);

    expect(result.kind).toBe(kind);
    expect(result.retryable).toBe(retryable);
    expect(result.requestId).toBe("req-1");
  });

  it("names the wait on a rate limit", () => {
    const result = describeUploadFailure(
      failure(429, "rate_limited", [], "slow", { retryAfterSeconds: 30 }),
    );

    expect(result.message).toContain("30 s");
  });

  it("names the dependency on a 503", () => {
    const result = describeUploadFailure(
      failure(503, "dependency_unavailable", [detail("storage", ["dependency"], "disk")]),
    );

    expect(result.kind).toBe("unavailable");
    expect(result.message).toBe("Storage is unavailable");
    expect(result.retryable).toBe(true);
  });

  it("treats a lost connection as retryable and does not claim that nothing was stored", () => {
    const result = describeUploadFailure(ApiError.network(new TypeError("fetch failed")));

    expect(result.kind).toBe("network");
    expect(result.retryable).toBe(true);
    expect(result.nextStep).toContain("not known whether the upload reached the API");
    expect(result.nextStep).toContain("never creates a duplicate version");
    expect(result.nextStep).not.toContain("Nothing was stored");
  });

  it("treats a missing API token as a session problem", () => {
    const result = describeUploadFailure(
      new ApiError({ status: 0, code: TOKEN_UNAVAILABLE_CODE, message: "no token" }),
    );

    expect(result.kind).toBe("session");
    expect(result.retryable).toBe(true);
  });

  it("wraps a plain error", () => {
    const result = describeUploadFailure(new Error("boom"));

    expect(result.kind).toBe("unknown");
    expect(result.message).toBe("boom");
    expect(result.requestId).toBeNull();
  });
});
