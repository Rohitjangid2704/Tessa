import createClient from "openapi-fetch";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildUploadFormData,
  pasteManifestRequest,
  uploadBundleRequest,
  type IntakeClient,
} from "@/features/bundles/bundle-requests";
import { describeUploadFailure } from "@/features/bundles/upload-errors";
import { ApiError } from "@/lib/api/errors";
import type { paths } from "@/lib/api/schema";
import type { RunningMockServer } from "@/mocks/server/http";
import { mockState } from "@/mocks/state";
import { startMockApi } from "@/tests/utils/mock-api";
import { STAGE_ONE_IDS } from "@/tests/utils/stage1";
import { bearer, mintApiToken } from "@/tests/utils/tokens";

const BILLING = STAGE_ONE_IDS.billing;
const GRACIE = STAGE_ONE_IDS.gracie;
const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]);

let running: RunningMockServer;
let client: IntakeClient;

beforeAll(async () => {
  running = await startMockApi();
  const token = await mintApiToken();
  client = createClient<paths>({
    baseUrl: running.baseUrl,
    fetch: (request) => {
      const headers = new Headers(request.headers);
      for (const [name, value] of Object.entries(bearer(token))) {
        headers.set(name, value);
      }
      return fetch(new Request(request, { headers }));
    },
  });
});

afterAll(async () => {
  await running.close();
});

beforeEach(() => {
  mockState.reset();
});

function zip(name: string, type = ""): File {
  return new File([ZIP_BYTES], name, { type });
}

function upload(name: string, overrides: { targetId?: string; note?: string; key?: string } = {}) {
  return uploadBundleRequest(client, {
    file: zip(name),
    targetId: overrides.targetId ?? BILLING,
    note: overrides.note ?? "",
    idempotencyKey: overrides.key ?? crypto.randomUUID(),
  });
}

async function failureOf(pending: Promise<unknown>) {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return describeUploadFailure(error);
  }
  throw new Error("the request was expected to fail");
}

describe("buildUploadFormData", () => {
  it("sends the file part as application/zip whatever the browser reported", () => {
    const form = buildUploadFormData({
      file: zip("tessa.zip", "application/x-zip-compressed"),
      targetId: BILLING,
      note: "  first pass  ",
      idempotencyKey: "k",
    });
    const part = form.get("file");

    expect(part).toBeInstanceOf(File);
    expect((part as File).type).toBe("application/zip");
    expect((part as File).name).toBe("tessa.zip");
    expect(form.get("target_id")).toBe(BILLING);
    expect(form.get("note")).toBe("first pass");
  });

  it("leaves the note out when it is blank", () => {
    const form = buildUploadFormData({
      file: zip("tessa.zip"),
      targetId: BILLING,
      note: "   ",
      idempotencyKey: "k",
    });

    expect(form.has("note")).toBe(false);
  });
});

describe("uploadBundleRequest against the mock API", () => {
  it("uploads a zip whose browser type is empty because the part is retyped", async () => {
    const result = await upload("valid.zip", { note: "first version" });

    expect(result.created).toBe(true);
    expect(result.dry_run_run_id).toBeNull();
    expect(result.bundle).toMatchObject({
      target_id: BILLING,
      version: 1,
      source: "zip",
      note: "first version",
      validation_status: "valid",
    });
    expect(result.bundle.completeness.status).toBe("meets_bar");
  });

  it("stores a below-bar bundle with partial earned points", async () => {
    const result = await upload("below-bar.zip");

    expect(result.created).toBe(true);
    expect(result.bundle.completeness.status).toBe("below_bar");
    expect(result.bundle.completeness.checks.some((check) => check.earned < check.weight)).toBe(
      true,
    );
  });

  it("stores an invalid bundle with errors", async () => {
    const result = await upload("invalid.zip");

    expect(result.created).toBe(true);
    expect(result.bundle.validation_status).toBe("invalid");
    expect(result.bundle.errors.length).toBeGreaterThan(0);
  });

  it("answers 200 created=false for a duplicate of the latest version", async () => {
    await upload("valid.zip", { targetId: GRACIE });

    const result = await upload("duplicate.zip", { targetId: GRACIE });

    expect(result.created).toBe(false);
    expect(result.bundle.version).toBe(2);
  });

  it("maps a secret to findings with file, line, pattern and a redacted excerpt", async () => {
    const failure = await failureOf(upload("secret.zip"));

    expect(failure.kind).toBe("secret_found");
    expect(failure.findings.length).toBeGreaterThan(0);
    expect(failure.findings[0]).toMatchObject({ file: "env.template", line: 7 });
    expect(failure.findings.every((finding) => finding.excerpt.includes("[REDACTED]"))).toBe(true);
  });

  it("maps 413, 422 and 409 outcomes", async () => {
    expect((await failureOf(upload("too-large.zip"))).kind).toBe("too_large");
    expect((await failureOf(upload("unknown-token.zip"))).kind).toBe("token_unknown");
    expect((await failureOf(upload("mismatch.zip"))).kind).toBe("token_mismatch");
  });

  it("replays the original answer for the same key and the same content", async () => {
    const key = crypto.randomUUID();

    const first = await upload("valid.zip", { key });
    const second = await upload("valid.zip", { key });

    expect(second.bundle.id).toBe(first.bundle.id);
    expect(second.created).toBe(first.created);
  });

  it("rejects the same key for different content as an idempotency conflict", async () => {
    const key = crypto.randomUUID();
    await upload("valid.zip", { key });

    const failure = await failureOf(upload("below-bar.zip", { key }));

    expect(failure.kind).toBe("idempotency_conflict");
  });

  it("maps a server limit that the client could not know about", async () => {
    mockState.stageOne.configureLimits({ bundle_max_zip_bytes: 8 });

    const failure = await failureOf(upload("valid.zip"));

    expect(failure.kind).toBe("too_large");
    expect(failure.code).toBe("archive_too_large");
  });
});

describe("pasteManifestRequest against the mock API", () => {
  it("creates a pasted version below the bar", async () => {
    const result = await pasteManifestRequest(client, {
      manifestYaml: "schema: x\ntarget_token: placeholder\n",
      targetId: BILLING,
      note: "",
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result.created).toBe(true);
    expect(result.bundle.source).toBe("manifest_paste");
    expect(result.bundle.completeness.status).toBe("below_bar");
  });

  it("maps a pasted secret", async () => {
    const failure = await failureOf(
      pasteManifestRequest(client, {
        manifestYaml: "# mock: secret\nname: x\n",
        targetId: BILLING,
        note: "",
        idempotencyKey: crypto.randomUUID(),
      }),
    );

    expect(failure.kind).toBe("secret_found");
  });
});
