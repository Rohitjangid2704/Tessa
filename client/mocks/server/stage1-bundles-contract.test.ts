import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { components } from "@/lib/api/schema";
import type { RunningMockServer } from "@/mocks/server/http";
import { UPLOAD_FILE_NAMES } from "@/mocks/stage1/outcomes";
import { mockState } from "@/mocks/state";
import { startMockApi } from "@/tests/utils/mock-api";
import {
  createStage1Client,
  errorOf,
  STAGE_ONE_IDS,
  type Stage1Client,
} from "@/tests/utils/stage1";

type Schemas = components["schemas"];

let running: RunningMockServer;
let client: Stage1Client;

beforeAll(async () => {
  running = await startMockApi();
  client = createStage1Client(running.baseUrl);
});

afterAll(async () => {
  await running.close();
});

beforeEach(() => {
  mockState.reset();
});

const BILLING = STAGE_ONE_IDS.billing;
const GRACIE = STAGE_ONE_IDS.gracie;
const MISSING_ID = "0198f6f2-4c2a-7d10-9c1e-000000000000";

async function uploadFor(targetId: string, name: string) {
  return client.upload({ name, targetId });
}

describe("POST /bundles outcomes chosen by file name", () => {
  it("valid.zip on a target without a bundle creates version 1 that meets the bar", async () => {
    const response = await uploadFor(BILLING, UPLOAD_FILE_NAMES.valid);
    expect(response.status).toBe(201);
    const result = (await response.json()) as Schemas["BundleUploadResult"];
    expect(result.created).toBe(true);
    expect(result.dry_run_run_id).toBeNull();
    expect(result.bundle).toMatchObject({
      target_id: BILLING,
      version: 1,
      source: "zip",
      validation_status: "valid",
      diff_summary: null,
      feature_count: 15,
    });
    expect(result.bundle.completeness).toMatchObject({ score: 92, bar: 80, status: "meets_bar" });
    expect(result.bundle.hooks_missing).toHaveLength(2);
    expect(response.headers.get("Idempotency-Replayed")).toBeNull();
  });

  it("below-bar.zip is valid with proportional partial earned values", async () => {
    const result = (await (
      await uploadFor(BILLING, UPLOAD_FILE_NAMES.belowBar)
    ).json()) as Schemas["BundleUploadResult"];
    expect(result.bundle.validation_status).toBe("valid");
    expect(result.bundle.completeness).toMatchObject({ score: 55, status: "below_bar" });
    const checks = Object.fromEntries(
      result.bundle.completeness.checks.map((check) => [check.id, check]),
    );
    expect(checks.required_sections).toMatchObject({ passed: true, earned: 20, weight: 20 });
    expect(checks.feature_examples).toMatchObject({ passed: false, earned: 8, weight: 20 });
    expect(checks.feature_examples?.fix_hint).toContain("example");
    expect(checks.seeds_reset_and_hash).toMatchObject({ earned: 0, weight: 15 });
    expect(result.bundle.completeness.checks.reduce((sum, check) => sum + check.earned, 0)).toBe(
      55,
    );
  });

  it("invalid.zip is stored as version 1 with errors, no catalog and no environment rows", async () => {
    const response = await uploadFor(BILLING, UPLOAD_FILE_NAMES.invalid);
    expect(response.status).toBe(201);
    const { bundle } = (await response.json()) as Schemas["BundleUploadResult"];
    expect(bundle.validation_status).toBe("invalid");
    expect(bundle.errors.length).toBeGreaterThan(3);
    expect(bundle.errors[0]).toMatchObject({
      severity: "error",
      file: "manifest.yaml",
      pointer: "/seeds",
      line: 212,
      column: 1,
    });
    expect(bundle.completeness.score).toBe(0);
    expect(bundle.feature_count).toBe(0);

    const catalog = (await (
      await client.get(`/api/v1/catalog?target_id=${BILLING}`)
    ).json()) as Schemas["Catalog"];
    expect(catalog).toEqual({
      bundle_id: null,
      bundle_version: null,
      roles: [],
      interfaces: [],
      areas: [],
    });
    const environment = (await (
      await client.get(`/api/v1/targets/${BILLING}/environment`)
    ).json()) as Schemas["EnvironmentList"];
    expect(environment.items).toEqual([]);
  });

  it("uploading the same content again answers 200 with created=false and the existing version", async () => {
    const first = (await (
      await uploadFor(BILLING, UPLOAD_FILE_NAMES.valid)
    ).json()) as Schemas["BundleUploadResult"];
    const again = await uploadFor(BILLING, UPLOAD_FILE_NAMES.valid);
    expect(again.status).toBe(200);
    const result = (await again.json()) as Schemas["BundleUploadResult"];
    expect(result.created).toBe(false);
    expect(result.bundle.id).toBe(first.bundle.id);
    expect(mockState.stageOne.bundlesOf(BILLING)).toHaveLength(1);
  });

  it("duplicate.zip returns the latest version with created=false when one exists", async () => {
    const response = await uploadFor(GRACIE, UPLOAD_FILE_NAMES.duplicate);
    expect(response.status).toBe(200);
    const result = (await response.json()) as Schemas["BundleUploadResult"];
    expect(result).toMatchObject({ created: false, bundle: { version: 2 } });

    const fresh = await uploadFor(BILLING, UPLOAD_FILE_NAMES.duplicate);
    expect(fresh.status).toBe(201);
  });

  it("fixing a below-bar bundle yields version 2 with a diff of added, removed and changed features", async () => {
    await uploadFor(BILLING, UPLOAD_FILE_NAMES.belowBar);
    const second = (await (
      await uploadFor(BILLING, UPLOAD_FILE_NAMES.valid)
    ).json()) as Schemas["BundleUploadResult"];
    expect(second.bundle.version).toBe(2);
    expect(second.bundle.diff_summary).toMatchObject({
      against_version: 1,
      features_added: 3,
      features_removed: 0,
    });
    expect(second.bundle.diff_summary?.features_changed).toBeGreaterThan(0);

    const diff = (await (
      await client.get(`/api/v1/bundles/${second.bundle.id}/diff`)
    ).json()) as Schemas["BundleDiff"];
    expect(
      diff.features
        .filter((entry) => entry.change === "added")
        .map((entry) => entry.feature_id)
        .sort(),
    ).toEqual([
      "access.admin.manage_roles",
      "reports.flow.export_week",
      "streaming.stream.property_events",
    ]);
    const changed = diff.features.find(
      (entry) => entry.feature_id === "smart_log.read.open_maintenance",
    );
    expect(changed).toMatchObject({ change: "changed" });
    expect(changed?.fields_changed).toEqual(["description"]);
    expect((changed?.before as { description: string }).description).toBe(
      "List open maintenance issues",
    );
    expect(diff.sections.map((entry) => entry.section)).toContain("features");
    expect(diff.summary).toMatch(
      /^Compared with version 1: 3 features added, 0 features removed, \d+ features changed\. Sections: /,
    );
    expect(diff.sections.map((entry) => entry.section)).toEqual(
      expect.arrayContaining(["features", "files:seeds", "files:oracle", "environment"]),
    );
    expect(
      diff.sections.every((entry) => !["schema", "target_token"].includes(entry.section)),
    ).toBe(true);
    expect(diff.features.map((entry) => entry.feature_id)).toEqual(
      [...diff.features.map((entry) => entry.feature_id)].sort(),
    );
  });

  it("reconciles the environment on every accepted bundle: new names appear unset, removed names go stale", async () => {
    await uploadFor(BILLING, UPLOAD_FILE_NAMES.belowBar);
    const afterFirst = (await (
      await client.get(`/api/v1/targets/${BILLING}/environment`)
    ).json()) as Schemas["EnvironmentList"];
    expect(afterFirst.items.map((item) => item.name)).toContain("GRACIE_LEGACY_API_KEY");
    expect(afterFirst.items.every((item) => !item.has_value && !item.stale)).toBe(true);

    await uploadFor(BILLING, UPLOAD_FILE_NAMES.valid);
    const afterSecond = (await (
      await client.get(`/api/v1/targets/${BILLING}/environment`)
    ).json()) as Schemas["EnvironmentList"];
    const legacy = afterSecond.items.find((item) => item.name === "GRACIE_LEGACY_API_KEY");
    expect(legacy?.stale).toBe(true);
    expect(afterSecond.items.find((item) => item.name === "GRACIE_READONLY_DSN")?.stale).toBe(
      false,
    );
    expect(afterSecond.items.at(-1)?.stale).toBe(true);
  });
});

describe("tests/fixtures/bundles placeholders", () => {
  const FIXTURE_DIRECTORY = join(process.cwd(), "tests", "fixtures", "bundles");

  it.each([
    ["valid.zip", "application/zip", 201],
    ["below-bar.zip", "application/zip", 201],
    ["invalid.zip", "application/zip", 201],
    ["duplicate.zip", "application/zip", 201],
    ["secret.zip", "application/zip", 422],
    ["too-large.zip", "application/zip", 413],
    ["mismatch.zip", "application/zip", 409],
    ["unknown-token.zip", "application/zip", 422],
    ["not-a-zip.txt", "text/plain", 415],
  ])("%s answers %i on a target without a bundle", async (name, type, status) => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURE_DIRECTORY, name)));
    const response = await client.upload({ name, type, bytes, targetId: BILLING });
    expect(response.status).toBe(type === "text/plain" ? 415 : status);
  });

  it("ships one placeholder per documented outcome", () => {
    expect(readdirSync(FIXTURE_DIRECTORY).sort()).toEqual([
      "below-bar.zip",
      "duplicate.zip",
      "invalid.zip",
      "mismatch.zip",
      "not-a-zip.txt",
      "secret.zip",
      "too-large.zip",
      "unknown-token.zip",
      "valid.zip",
    ]);
  });
});

describe("POST /bundles errors", () => {
  it("secret.zip is 422 bundle_contains_secret with file and line locations and stores nothing", async () => {
    const response = await uploadFor(BILLING, UPLOAD_FILE_NAMES.secret);
    expect(response.status).toBe(422);
    const error = await errorOf(response);
    expect(error.code).toBe("bundle_contains_secret");
    expect(error.details[0]).toEqual({
      loc: ["file", "env.template", 7],
      code: "aws_access_key",
      message: "AWS_ACCESS_KEY_ID=[REDACTED]",
    });
    expect(mockState.stageOne.bundlesOf(BILLING)).toHaveLength(0);
  });

  it("too-large.zip, the upload_413 fault and the configured limit are 413 payload_too_large", async () => {
    const byName = await uploadFor(BILLING, UPLOAD_FILE_NAMES.tooLarge);
    expect(byName.status).toBe(413);
    const tooLarge = await errorOf(byName);
    expect(tooLarge.code).toBe("payload_too_large");
    expect(tooLarge.details[0]).toMatchObject({ loc: ["file"], code: "archive_too_large" });
    expect(tooLarge.message).toBe("The zip is larger than 26214400 bytes");

    mockState.faults.apply({ upload_413: true });
    expect((await uploadFor(BILLING, UPLOAD_FILE_NAMES.valid)).status).toBe(413);
    mockState.faults.apply({ upload_413: false });
    expect((await uploadFor(BILLING, UPLOAD_FILE_NAMES.valid)).status).toBe(201);

    mockState.stageOne.configureLimits({ bundle_max_zip_bytes: 10 });
    expect((await uploadFor(GRACIE, "anything.zip")).status).toBe(413);
  });

  it("refuses a file that is not a zip with 415", async () => {
    const response = await client.upload({
      name: UPLOAD_FILE_NAMES.notAZip,
      type: "text/plain",
      targetId: BILLING,
    });
    expect(response.status).toBe(415);
    const refused = await errorOf(response);
    expect(refused.code).toBe("unsupported_media_type");
    expect(refused.details[0]).toMatchObject({
      loc: ["form", "file"],
      code: "unsupported_media_type",
    });
    expect(refused.message).toBe("The file must be a zip (application/zip), not text/plain");
    const windowsType = await client.upload({
      name: "valid.zip",
      type: "application/x-zip-compressed",
      targetId: BILLING,
    });
    expect(windowsType.status).toBe(201);
  });

  it("mismatch.zip is 409 target_token_mismatch and unknown-token.zip is 422 target_token_unknown", async () => {
    const mismatch = await uploadFor(BILLING, UPLOAD_FILE_NAMES.mismatch);
    expect(mismatch.status).toBe(409);
    const mismatchError = await errorOf(mismatch);
    expect(mismatchError.code).toBe("target_token_mismatch");
    expect(mismatchError.details[0]).toMatchObject({
      loc: ["form", "target_id"],
      code: "target_token_mismatch",
    });
    const unknown = await uploadFor(BILLING, UPLOAD_FILE_NAMES.unknownToken);
    expect(unknown.status).toBe(422);
    const unknownError = await errorOf(unknown);
    expect(unknownError.code).toBe("target_token_unknown");
    expect(unknownError.details[0]?.loc).toEqual(["manifest", "target_token"]);
  });

  it("resolves the target from a token inside the file and rejects a token of another target", async () => {
    const token = (name: string) => new TextEncoder().encode(`target_token: ${name}\n`);
    const billingToken = mockState.stageOne.findTarget(BILLING)?.targetToken ?? "";
    const gracieToken = mockState.stageOne.findTarget(GRACIE)?.targetToken ?? "";
    const byToken = await client.upload({ name: "valid.zip", bytes: token(billingToken) });
    expect(byToken.status).toBe(201);
    expect(((await byToken.json()) as Schemas["BundleUploadResult"]).bundle.target_id).toBe(
      BILLING,
    );

    const crossed = await client.upload({
      name: "valid.zip",
      bytes: token(gracieToken),
      targetId: BILLING,
    });
    expect(crossed.status).toBe(409);

    const nothing = await client.upload({ name: "valid.zip" });
    expect(nothing.status).toBe(422);
    expect((await errorOf(nothing)).code).toBe("target_token_unknown");

    const stranger = await client.upload({
      name: "valid.zip",
      bytes: token("tgt_aaaaaaaaaaaaaaaaaaaaaa"),
    });
    expect(stranger.status).toBe(422);
  });

  it("accepts the previous token after a rotation", async () => {
    const before = mockState.stageOne.findTarget(BILLING)?.targetToken ?? "";
    await client.send("POST", `/api/v1/targets/${BILLING}/token/rotate`, undefined, {
      role: "member",
    });
    const response = await client.upload({
      name: "valid.zip",
      bytes: new TextEncoder().encode(before),
    });
    expect(response.status).toBe(201);
    const { bundle } = (await response.json()) as Schemas["BundleUploadResult"];
    expect(bundle.warnings).toContainEqual(
      expect.objectContaining({
        code: "target_token_rotated",
        severity: "warning",
        file: "manifest.yaml",
        pointer: "/target_token",
      }),
    );
  });

  it("checks the secret scan before it resolves the target, like the real intake", async () => {
    const response = await client.upload({
      name: UPLOAD_FILE_NAMES.secret,
      targetId: STAGE_ONE_IDS.legacyPortal,
    });
    expect(response.status).toBe(422);
    const error = await errorOf(response);
    expect(error.code).toBe("bundle_contains_secret");
    expect(error.message).toContain(
      "The bundle contains 2 apparent secret(s) in 2 file(s); nothing was stored",
    );
    expect(error.details.map((detail) => detail.code)).toEqual(["aws_access_key", "dsn_password"]);
    expect(JSON.stringify(error)).not.toMatch(/AKIA[0-9A-Z]{16}/);
  });

  it("requires an Idempotency-Key, the member role and an active, known target", async () => {
    const noKey = await client.upload({ name: "valid.zip", targetId: BILLING, key: null });
    expect(noKey.status).toBe(400);
    expect((await errorOf(noKey)).code).toBe("idempotency_key_required");
    expect(
      (await client.upload({ name: "valid.zip", targetId: BILLING, role: "viewer" })).status,
    ).toBe(403);
    expect((await uploadFor(MISSING_ID, "valid.zip")).status).toBe(404);
    expect((await uploadFor(STAGE_ONE_IDS.legacyPortal, "valid.zip")).status).toBe(409);
    const badId = await uploadFor("nope", "valid.zip");
    expect(badId.status).toBe(422);
    expect((await errorOf(badId)).details[0]).toMatchObject({ loc: ["body", "target_id"] });
  });

  it("validates the form: missing file and an over-long note", async () => {
    const form = new FormData();
    const missing = await fetch(`${running.baseUrl}/api/v1/bundles`, {
      method: "POST",
      headers: { ...(await client.headers()), "Idempotency-Key": "missing-file-key-1" },
      body: form,
    });
    expect(missing.status).toBe(422);
    expect((await errorOf(missing)).details[0]).toMatchObject({
      loc: ["body", "file"],
      code: "missing",
    });
    const note = await client.upload({
      name: "valid.zip",
      targetId: BILLING,
      note: "x".repeat(501),
    });
    expect(note.status).toBe(422);
    expect((await errorOf(note)).details[0]).toMatchObject({
      loc: ["body", "note"],
      code: "string_too_long",
    });
  });

  it("replays the stored response for the same key and file and refuses a different file", async () => {
    const key = "upload-replay-key-0001";
    const first = await client.upload({ name: "valid.zip", targetId: BILLING, key });
    const replay = await client.upload({ name: "valid.zip", targetId: BILLING, key });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(mockState.stageOne.bundlesOf(BILLING)).toHaveLength(1);
    const different = await client.upload({ name: "below-bar.zip", targetId: BILLING, key });
    expect(different.status).toBe(409);
    expect((await errorOf(different)).code).toBe("idempotency_conflict");
  });

  it("does not store failed uploads under the key, so a retry can succeed", async () => {
    const key = "upload-retry-key-00001";
    mockState.faults.apply({ upload_413: true });
    expect((await client.upload({ name: "valid.zip", targetId: BILLING, key })).status).toBe(413);
    mockState.faults.apply({ upload_413: false });
    expect((await client.upload({ name: "valid.zip", targetId: BILLING, key })).status).toBe(201);
  });
});

describe("POST /bundles/paste", () => {
  const paste = (body: unknown, key: string | null = crypto.randomUUID()) =>
    client.send("POST", "/api/v1/bundles/paste", body, {
      role: "member",
      headers: key === null ? {} : { "Idempotency-Key": key },
    });

  it("a pasted manifest lands below the bar with source manifest_paste", async () => {
    const response = await paste({
      target_id: BILLING,
      manifest_yaml: "app:\n  name: Billing\n",
      note: "pasted",
    });
    expect(response.status).toBe(201);
    const { bundle } = (await response.json()) as Schemas["BundleUploadResult"];
    expect(bundle).toMatchObject({
      source: "manifest_paste",
      note: "pasted",
      validation_status: "valid",
      file_count: 1,
    });
    expect(bundle.completeness).toMatchObject({ score: 47, status: "below_bar" });
  });

  it("a marker comment picks the outcome", async () => {
    const valid = await paste({ target_id: BILLING, manifest_yaml: "# mock: valid\napp: {}\n" });
    expect(((await valid.json()) as Schemas["BundleUploadResult"]).bundle.completeness.status).toBe(
      "meets_bar",
    );
    const secret = await paste({ target_id: BILLING, manifest_yaml: "# mock: secret\napp: {}\n" });
    expect((await errorOf(secret)).code).toBe("bundle_contains_secret");
    const invalid = await paste({
      target_id: BILLING,
      manifest_yaml: "# mock: invalid\napp: {}\n",
    });
    expect(((await invalid.json()) as Schemas["BundleUploadResult"]).bundle.validation_status).toBe(
      "invalid",
    );
  });

  it("resolves the target from the token in the manifest and rejects mismatches", async () => {
    const billingToken = mockState.stageOne.findTarget(BILLING)?.targetToken ?? "";
    const gracieToken = mockState.stageOne.findTarget(GRACIE)?.targetToken ?? "";
    const byToken = await paste({ manifest_yaml: `target_token: ${billingToken}\n` });
    expect(((await byToken.json()) as Schemas["BundleUploadResult"]).bundle.target_id).toBe(
      BILLING,
    );
    const crossed = await paste({
      target_id: BILLING,
      manifest_yaml: `target_token: ${gracieToken}\n`,
    });
    expect(crossed.status).toBe(409);
    expect((await errorOf(await paste({ manifest_yaml: "app: {}\n" }))).code).toBe(
      "target_token_unknown",
    );
  });

  it("validates the body, the size limit and the key", async () => {
    const empty = await paste({ target_id: BILLING, manifest_yaml: "" });
    expect((await errorOf(empty)).details[0]).toMatchObject({
      loc: ["body", "manifest_yaml"],
      code: "string_too_short",
    });
    mockState.stageOne.configureLimits({ bundle_max_manifest_bytes: 5 });
    const large = await paste({ target_id: BILLING, manifest_yaml: "app: {}\n" });
    expect(large.status).toBe(413);
    expect((await paste({ target_id: BILLING, manifest_yaml: "a" }, null)).status).toBe(400);
  });
});

describe("bundle reads", () => {
  it("lists versions newest first with summaries and pages them", async () => {
    const page = (await (
      await client.get(`/api/v1/targets/${GRACIE}/bundles?include_total=true`, "viewer")
    ).json()) as Schemas["BundleSummaryPage"];
    expect(page.total).toBe(2);
    expect(page.items.map((item) => item.version)).toEqual([2, 1]);
    expect(page.items[0]).toMatchObject({
      validation_status: "valid",
      completeness_score: 92,
      completeness_status: "meets_bar",
      feature_count: 15,
      source: "zip",
    });
    const first = (await (
      await client.get(`/api/v1/targets/${GRACIE}/bundles?limit=1`)
    ).json()) as Schemas["BundleSummaryPage"];
    expect(first.next_cursor).not.toBeNull();
    const ascending = (await (
      await client.get(`/api/v1/targets/${GRACIE}/bundles?sort=version`)
    ).json()) as Schemas["BundleSummaryPage"];
    expect(ascending.items.map((item) => item.version)).toEqual([1, 2]);
    expect((await client.get(`/api/v1/targets/${GRACIE}/bundles?sort=hash`)).status).toBe(422);
    expect((await client.get(`/api/v1/targets/${MISSING_ID}/bundles`)).status).toBe(404);
  });

  it("reads a bundle with completeness and the diff summary against the previous valid version", async () => {
    const latest = mockState.stageOne.latestBundle(GRACIE);
    const bundle = (await (
      await client.get(`/api/v1/bundles/${latest?.bundle.id}`, "viewer")
    ).json()) as Schemas["Bundle"];
    expect(bundle.completeness.checks).toHaveLength(6);
    expect(bundle.completeness.checks.map((check) => check.weight)).toEqual([
      20, 15, 20, 15, 15, 15,
    ]);
    expect(bundle.diff_summary).toMatchObject({
      against_version: 1,
      against_bundle_id: mockState.stageOne.bundlesOf(GRACIE)[0]?.bundle.id,
    });
    expect(bundle.warnings[0]).toMatchObject({ code: "file_ignored", severity: "warning" });
    expect(bundle.hooks_missing[0]).toEqual({
      id: "pin_clock",
      description: "No QA route pins the server clock",
    });
    expect((await client.get(`/api/v1/bundles/${MISSING_ID}`)).status).toBe(404);
  });

  it("diffs against an explicit bundle, none for the first version and empty for an invalid bundle", async () => {
    const [first, second] = mockState.stageOne.bundlesOf(GRACIE);
    const reverse = (await (
      await client.get(`/api/v1/bundles/${first?.bundle.id}/diff?against=${second?.bundle.id}`)
    ).json()) as Schemas["BundleDiff"];
    expect(reverse.features.filter((entry) => entry.change === "removed")).toHaveLength(3);
    const none = (await (
      await client.get(`/api/v1/bundles/${first?.bundle.id}/diff`)
    ).json()) as Schemas["BundleDiff"];
    expect(none).toMatchObject({
      against_bundle_id: null,
      features: [],
      sections: [],
      summary: "There is no earlier valid version to compare with.",
    });
    const broken = mockState.stageOne.bundlesOf(STAGE_ONE_IDS.brokenImport)[0];
    const invalid = (await (
      await client.get(`/api/v1/bundles/${broken?.bundle.id}/diff`)
    ).json()) as Schemas["BundleDiff"];
    expect(invalid.features).toEqual([]);
    const crossed = await client.get(
      `/api/v1/bundles/${first?.bundle.id}/diff?against=${broken?.bundle.id}`,
    );
    expect(crossed.status).toBe(422);
    expect((await errorOf(crossed)).details[0]).toMatchObject({
      loc: ["query", "against"],
      code: "bundle_not_comparable",
    });
    expect(
      (await client.get(`/api/v1/bundles/${first?.bundle.id}/diff?against=${MISSING_ID}`)).status,
    ).toBe(404);
    expect((await client.get(`/api/v1/bundles/${first?.bundle.id}/diff?other=1`)).status).toBe(422);
  });

  it("lists stored files and previews text with a truncated notice for big files", async () => {
    const latest = mockState.stageOne.latestBundle(GRACIE);
    const id = latest?.bundle.id;
    const files = (await (
      await client.get(`/api/v1/bundles/${id}/files`, "viewer")
    ).json()) as Schemas["BundleFileList"];
    expect(files.items.map((item) => item.path)).toContain("manifest.yaml");
    expect(files.items.every((item) => /^[0-9a-f]{64}$/.test(item.sha256))).toBe(true);

    const manifest = (await (
      await client.get(`/api/v1/bundles/${id}/files/manifest.yaml`)
    ).json()) as Schemas["BundleFileContent"];
    expect(manifest.truncated).toBe(false);
    expect(manifest.content).toContain("target_token: tgt_graciedemotokenaaaaaaa");
    expect(manifest.content).toContain("smart_log.read.open_maintenance");

    const nested = (await (
      await client.get(
        `/api/v1/bundles/${id}/files/${encodeURIComponent("oracle/open_maintenance.sql")}`,
      )
    ).json()) as Schemas["BundleFileContent"];
    expect(nested.path).toBe("oracle/open_maintenance.sql");
    const big = (await (
      await client.get(`/api/v1/bundles/${id}/files/openapi.json`)
    ).json()) as Schemas["BundleFileContent"];
    expect(big.truncated).toBe(true);
    expect((await client.get(`/api/v1/bundles/${id}/files/nope.txt`)).status).toBe(404);
  });
});

describe("GET /catalog", () => {
  const catalog = async (query: string) =>
    (await (
      await client.get(`/api/v1/catalog?target_id=${GRACIE}${query}`, "viewer")
    ).json()) as Schemas["Catalog"];
  const featureIds = (body: Schemas["Catalog"]) =>
    body.areas.flatMap((area) => area.items.map((item) => item.feature_id));

  it("returns the latest valid bundle as a tree by area with roles and interfaces", async () => {
    const body = await catalog("");
    expect(body.bundle_version).toBe(2);
    expect(body.areas.map((area) => area.name)).toEqual([
      "Account & Access",
      "Guest Requests",
      "Reports",
      "Smart Log",
      "Streaming & Jobs",
    ]);
    expect(featureIds(body)).toHaveLength(15);
    expect(body.roles).toHaveLength(5);
    expect(body.interfaces.map((entry) => entry.kind)).toEqual([
      "sse",
      "http",
      "browser",
      "sse",
      "webhook",
    ]);
    const kinds = new Set(body.areas.flatMap((area) => area.items.map((item) => item.kind)));
    expect([...kinds].sort()).toEqual(["admin", "auth", "flow", "job", "read", "stream", "write"]);
    const confidences = new Set(
      body.areas.flatMap((area) => area.items.map((item) => item.confidence)),
    );
    expect(confidences.size).toBe(3);
  });

  it("carries writes_to, confirmation and expect_db on a write feature", async () => {
    const write = (await catalog("&kind=write")).areas
      .flatMap((area) => area.items)
      .find((item) => item.feature_id === "guest_requests.write.create_service_request");
    expect(write).toMatchObject({
      writes_to: "guest_requests",
      expect_db: { table: "guest_requests" },
    });
    expect(write?.confirmation).toContain("Confirm button");
    expect(write?.examples).toHaveLength(2);
  });

  it("filters by area, kind, role including all, interface, confidence and text", async () => {
    expect((await catalog("&area=Reports")).areas.map((area) => area.name)).toEqual(["Reports"]);
    expect(featureIds(await catalog("&kind=stream&kind=job")).sort()).toEqual([
      "streaming.job.escalation_sweep",
      "streaming.stream.chat_reply",
      "streaming.stream.property_events",
    ]);
    const manager = featureIds(await catalog("&role=manager"));
    expect(manager).toContain("reports.read.occupancy_summary");
    expect(manager).toContain("access.auth.login_staff");
    expect(manager).not.toContain("guest_requests.write.create_service_request");
    expect(featureIds(await catalog("&interface_id=events_sse"))).toEqual([
      "streaming.stream.property_events",
    ]);
    expect(featureIds(await catalog("&confidence=low")).sort()).toEqual([
      "access.admin.manage_roles",
      "reports.flow.export_week",
      "streaming.job.escalation_sweep",
    ]);
    expect(featureIds(await catalog("&q=TOWELS"))).toEqual([]);
    expect(featureIds(await catalog("&q=maintenance"))).toContain(
      "smart_log.read.open_maintenance",
    );
  });

  it("returns 200 with empty arrays and null ids for a target without a valid bundle", async () => {
    const response = await client.get(`/api/v1/catalog?target_id=${BILLING}`, "viewer");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      bundle_id: null,
      bundle_version: null,
      roles: [],
      interfaces: [],
      areas: [],
    });
  });

  it("echoes the ids with empty arrays for an explicit invalid bundle and honours an explicit older bundle", async () => {
    const broken = mockState.stageOne.bundlesOf(STAGE_ONE_IDS.brokenImport)[0];
    const echoed = (await (
      await client.get(
        `/api/v1/catalog?target_id=${STAGE_ONE_IDS.brokenImport}&bundle_id=${broken?.bundle.id}`,
      )
    ).json()) as Schemas["Catalog"];
    expect(echoed).toEqual({
      bundle_id: broken?.bundle.id,
      bundle_version: 1,
      roles: [],
      interfaces: [],
      areas: [],
    });
    const first = mockState.stageOne.bundlesOf(GRACIE)[0];
    const older = await catalog(`&bundle_id=${first?.bundle.id}`);
    expect(older.bundle_version).toBe(1);
    expect(featureIds(older)).toHaveLength(12);
    expect(
      (await client.get(`/api/v1/catalog?target_id=${GRACIE}&bundle_id=${broken?.bundle.id}`))
        .status,
    ).toBe(404);
  });

  it("rejects a missing target_id, unknown keys and bad enum values", async () => {
    const missing = await client.get("/api/v1/catalog");
    expect(missing.status).toBe(422);
    expect((await errorOf(missing)).details[0]).toMatchObject({
      loc: ["query", "target_id"],
      code: "missing",
    });
    const unknown = await client.get(`/api/v1/catalog?target_id=${GRACIE}&sort=name`);
    expect((await errorOf(unknown)).details[0]?.loc).toEqual(["query", "sort"]);
    const kind = await client.get(`/api/v1/catalog?target_id=${GRACIE}&kind=nope`);
    expect((await errorOf(kind)).details[0]).toMatchObject({
      loc: ["query", "kind", 0],
      code: "enum",
    });
    expect((await client.get(`/api/v1/catalog?target_id=${MISSING_ID}`)).status).toBe(404);
  });

  it("reads one catalog item by id", async () => {
    const item = (await catalog("")).areas[0]?.items[0];
    const found = await client.get(`/api/v1/catalog/items/${item?.id}`, "viewer");
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual(item);
    expect((await client.get(`/api/v1/catalog/items/${MISSING_ID}`)).status).toBe(404);
  });
});
