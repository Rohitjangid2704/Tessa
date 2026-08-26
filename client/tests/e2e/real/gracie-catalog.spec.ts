import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page, type Response } from "@playwright/test";
import { apiOrigin } from "../helpers/env";
import { apiGet, apiRequest } from "./support/api";
import { startFakeTarget, unusedPortOrigin, type FakeTarget } from "./support/fake-target";
import { buildBundleFixtures, type BuiltFixtures } from "./support/fixtures";
import {
  expectNoPlaintextInVault,
  expectNoSecretInBrowser,
  expectNoSecretInServerLogs,
  expectNoSecretInTraffic,
  recordTraffic,
} from "./support/leaks";
import {
  countBundleRows,
  countStoredValues,
  createTruthDatabase,
  type TruthDatabase,
} from "./support/postgres";
import { apiDataDirectory } from "./support/stack";

const SETTLE_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 60_000;
const TOKEN_PATTERN = /tgt_[a-z2-7]{22}/;
const SCHEMA_URL = `${apiOrigin()}/schemas/bundle.v1.json`;
const LEAKED_GITHUB_TOKEN = "ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const LEAKED_DB_PASSWORD = "s3cr3t-Passw0rd";
const RUN_ID = randomBytes(4).toString("hex");

interface BundleView {
  id: string;
  version: number;
  validation_status: string;
  source: string;
  feature_count: number;
  errors: { code: string }[];
  completeness: {
    score: number;
    bar: number;
    status: string;
    checks: {
      id: string;
      weight: number;
      earned: number;
      passed: boolean;
      fix_hint: string | null;
    }[];
  };
  diff_summary: {
    against_version: number | null;
    features_added: number;
    features_removed: number;
    features_changed: number;
  } | null;
}

interface UploadOutcome {
  status: number;
  headers: Record<string, string>;
  body: { bundle?: BundleView; created?: boolean; error?: { code: string; details: unknown[] } };
}

interface HealthRowView {
  interface_id: string;
  kind: string;
  status: string;
  message: string | null;
  variables: string[];
}

const state = {
  targetId: "",
  targetToken: "",
  fixtures: undefined as BuiltFixtures | undefined,
  promptText: "",
  bundleIds: new Map<number, string>(),
  expectedVersions: [] as number[],
  typedSecrets: [] as string[],
};

let fakeTarget: FakeTarget;
let truthDatabase: TruthDatabase;

function fixtures(): BuiltFixtures {
  if (state.fixtures === undefined) {
    throw new Error("the fixture zips are built after the target token is known");
  }
  return state.fixtures;
}

function intakeUrl(): string {
  return `/targets/${state.targetId}/bundles`;
}

function result(page: Page): Locator {
  return page.getByRole("region", { name: "Upload result" });
}

function failure(page: Page): Locator {
  return page.getByRole("alert", { name: "Upload failed" });
}

function versionsTable(page: Page): Locator {
  return page.getByRole("table", { name: "Bundle versions" });
}

function isBundlePost(response: Response): boolean {
  return (
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/bundles"
  );
}

async function parseBody(response: Response): Promise<UploadOutcome["body"]> {
  const text = await response.text();
  try {
    return JSON.parse(text) as UploadOutcome["body"];
  } catch {
    return {};
  }
}

async function openIntake(page: Page): Promise<void> {
  await page.goto(intakeUrl());
  await expect(page.getByRole("heading", { level: 2, name: "Add a version" })).toBeVisible();
  await expect(page.getByLabel("Bundle zip")).toBeEnabled();
  await expect(page.getByText(/at most [\d.]+ (B|KiB|MiB)/)).toBeVisible();
}

async function chooseFixture(page: Page, name: string): Promise<void> {
  await page.getByLabel("Bundle zip").setInputFiles(fixtures().path(name as never));
  await expect(page.getByRole("group", { name: "File ready to upload" })).toContainText(name);
}

async function uploadFixture(page: Page, name: string): Promise<UploadOutcome> {
  await chooseFixture(page, name);
  const responded = page.waitForResponse(isBundlePost);
  await page.getByRole("button", { name: "Upload and validate" }).click();
  const response = await responded;
  const outcome = {
    status: response.status(),
    headers: response.headers(),
    body: await parseBody(response),
  };
  if (outcome.body.bundle !== undefined && outcome.status === 201) {
    state.bundleIds.set(outcome.body.bundle.version, outcome.body.bundle.id);
    state.expectedVersions.push(outcome.body.bundle.version);
  }
  return outcome;
}

async function readBundle(page: Page, bundleId: string): Promise<BundleView> {
  const response = await apiGet<BundleView>(page, `/api/v1/bundles/${bundleId}`);
  expect(response.status).toBe(200);
  return response.body;
}

async function listVersions(page: Page): Promise<number[]> {
  const response = await apiGet<{ items: { version: number }[] }>(
    page,
    `/api/v1/targets/${state.targetId}/bundles?sort=version&limit=100`,
  );
  expect(response.status).toBe(200);
  return response.body.items.map((item) => item.version);
}

async function storedVersionDirectories(): Promise<string[]> {
  const directory = path.join(apiDataDirectory(), "bundles", state.targetId);
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory).sort();
}

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

async function expectNothingStoredSince(page: Page): Promise<void> {
  expect(await listVersions(page)).toEqual([...state.expectedVersions].sort((a, b) => a - b));
  expect(countBundleRows(state.targetId)).toBe(state.expectedVersions.length);
  expect(await storedVersionDirectories()).toEqual(state.expectedVersions.map(String).sort());
}

async function chooseAppKind(page: Page, label: string): Promise<void> {
  await page.getByRole("combobox", { name: "App kind" }).click();
  await page.getByRole("option", { name: label }).click();
}

function variable(page: Page, name: string): Locator {
  return page.locator(`[data-variable="${name}"]`);
}

function field(page: Page, name: string): Locator {
  return variable(page, name).getByLabel(name, { exact: true });
}

function saveButton(page: Page): Locator {
  return page.getByRole("button", { name: "Save changes" });
}

function runButton(page: Page): Locator {
  return page.getByRole("button", { name: "Run health checks", exact: true });
}

function healthRow(page: Page, id: string): Locator {
  return page.locator(`[data-slot=health-row][data-interface="${id}"]`);
}

async function openEnvironment(page: Page): Promise<void> {
  await page.goto(`/targets/${state.targetId}/environment`);
  await expect(page.getByRole("form", { name: "Environment variables" })).toBeVisible({
    timeout: SETTLE_TIMEOUT_MS,
  });
}

async function runHealthChecks(page: Page): Promise<void> {
  await runButton(page).click();
  await expect(page.getByRole("progressbar", { name: "Running health checks" })).toHaveCount(0, {
    timeout: HEALTH_TIMEOUT_MS,
  });
  await expect(runButton(page)).toBeEnabled();
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fakeTarget = await startFakeTarget();
  truthDatabase = createTruthDatabase();
});

test.afterAll(async () => {
  await fakeTarget?.stop();
  truthDatabase?.drop();
});

test.describe("a. target and Discovery prompt", () => {
  test("creates the Gracie target and generates a prompt with its token and the schema URL", async ({
    page,
  }) => {
    await page.goto("/targets/new");
    await page.getByLabel("Name").fill("Gracie");
    await chooseAppKind(page, "LLM assistant");
    await page.getByRole("button", { name: "Create target" }).click();
    await expect(page.getByText("Target created")).toBeVisible();
    await expect(page.getByText("QA", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Generate Discovery prompt" }).click();

    const prompt = page.getByRole("textbox", { name: "Discovery prompt" });
    await expect(prompt).toHaveValue(TOKEN_PATTERN);
    state.promptText = await prompt.inputValue();
    state.targetToken = TOKEN_PATTERN.exec(state.promptText)?.[0] ?? "";
    expect(state.promptText).toContain(`target_token`);
    expect(state.promptText).toContain(SCHEMA_URL);
    expect(state.promptText).toContain("Format conventions");
    expect(state.promptText).toContain("env.template");
    expect(state.promptText).not.toMatch(/\{\{[A-Z_]+\}\}/);
    await expect(page.locator("[data-slot=discovery-prompt-panel] dl")).toContainText(
      state.targetToken,
    );

    const href = await page
      .getByRole("link", { name: "Open the target page" })
      .getAttribute("href");
    state.targetId = href?.split("/").pop() ?? "";
    expect(state.targetId).toMatch(/^[0-9a-f-]{36}$/);

    const target = await apiGet<{
      name: string;
      app_kind: string;
      tier: string;
      target_token: string;
    }>(page, `/api/v1/targets/${state.targetId}`);
    expect(target.body).toMatchObject({
      name: "Gracie",
      app_kind: "llm_assistant",
      tier: "qa",
      target_token: state.targetToken,
    });
    const issues = await apiGet<{ items: { template_name: string; text: string }[] }>(
      page,
      `/api/v1/targets/${state.targetId}/prompt-issues`,
    );
    expect(issues.body.items).toHaveLength(1);
    expect(issues.body.items[0]?.template_name).toBe("discovery");
    expect(issues.body.items[0]?.text.replace(/\r\n/g, "\n")).toBe(state.promptText);
  });

  test("Copy puts the exact prompt text on the clipboard", async ({ page, context, baseURL }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(baseURL ?? "http://localhost:3000").origin,
    });
    await page.goto(`/targets/${state.targetId}`);
    await expect(page.getByRole("textbox", { name: "Discovery prompt" })).toHaveValue(
      state.promptText,
    );

    await page.getByRole("button", { name: "Copy prompt" }).click();

    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied.replace(/\r\n/g, "\n")).toBe(state.promptText);
  });

  test("the checklist is ticked, shows the zip command and survives a reload", async ({ page }) => {
    await page.goto(`/targets/${state.targetId}`);
    await expect(page.getByRole("textbox", { name: "Discovery prompt" })).toBeVisible();

    await page.getByRole("checkbox", { name: "Open VS Code" }).check();
    await page.getByRole("checkbox", { name: "Paste the prompt and send it" }).check();
    await page.getByRole("checkbox", { name: "Zip the tessa/ folder" }).check();
    await expect(page.getByText("3 of 7 steps done")).toBeVisible();
    await expect(
      page.getByRole("group", { name: "PowerShell command" }).getByText(/Compress-Archive/),
    ).toBeVisible();

    await page.reload();

    await expect(page.getByText("3 of 7 steps done")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Open VS Code" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Zip the tessa/ folder" })).toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: "Open Claude Code in that window" }),
    ).not.toBeChecked();
  });

  test("builds the fixture bundles with the token read from the target page", async ({ page }) => {
    await page.goto(`/targets/${state.targetId}`);
    const shown = (await page.locator("[data-slot=token-card] code").innerText()).trim();
    expect(shown).toBe(state.targetToken);

    state.fixtures = buildBundleFixtures(shown);

    expect(existsSync(fixtures().path("gracie_like.zip"))).toBe(true);
    expect(existsSync(fixtures().path("paste_only.manifest.yaml"))).toBe(true);
  });
});

test.describe("b. bundle intake with the fixture bundles", () => {
  test("minimal_valid.zip is version 1, scores 70 and is below the bar; the Fix-up prompt lists exactly the failing checks", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.addInitScript(() => {
      const recorded: { name: string; type: string }[] = [];
      Object.defineProperty(window, "__bundleParts", { value: recorded });
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        if (
          input instanceof Request &&
          input.method === "POST" &&
          input.url.endsWith("/api/v1/bundles")
        ) {
          const form = await input.clone().formData();
          const file = form.get("file");
          if (file instanceof File) {
            recorded.push({ name: file.name, type: file.type });
          }
        }
        return original(input, init);
      };
    });
    await openIntake(page);
    await expect(page.getByRole("heading", { name: "No versions yet" })).toBeVisible();

    const upload = await uploadFixture(page, "minimal_valid.zip");

    expect(upload.status).toBe(201);
    expect(upload.headers["idempotency-replayed"]).toBeUndefined();
    expect(upload.body.created).toBe(true);
    const bundle = upload.body.bundle as BundleView;
    expect(bundle).toMatchObject({ version: 1, validation_status: "valid", source: "zip" });
    expect(bundle.completeness).toMatchObject({ score: 70, bar: 80, status: "below_bar" });
    expect(bundle.diff_summary).toBeNull();
    await expect(result(page).getByRole("heading", { name: "Version 1 created" })).toBeVisible();
    await expect(result(page)).toContainText("Below bar");
    await expect(result(page)).toContainText("Score 70 of 100, bar 80");
    const parts = await page.evaluate(
      () =>
        (window as unknown as { __bundleParts: { name: string; type: string }[] }).__bundleParts,
    );
    expect(parts).toEqual([{ name: "minimal_valid.zip", type: "application/zip" }]);

    await result(page).getByRole("link", { name: "Open version 1" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Version 1" })).toBeVisible();
    const generate = page.getByRole("button", { name: "Generate Fix-up prompt" });
    await expect(generate).toHaveAttribute("data-variant", "default");
    await generate.click();
    const dialog = page.getByRole("dialog", { name: "Fix-up prompt for version 1" });
    const text = dialog.getByRole("textbox", { name: "Fix-up prompt text" });
    await expect(text).toHaveValue(/Open items/);
    const prompt = (await text.inputValue()).replace(/\r\n/g, "\n");

    const failing = bundle.completeness.checks.filter((check) => check.earned < check.weight);
    expect(failing.length).toBeGreaterThan(0);
    const listedChecks = [...prompt.matchAll(/\[check\] completeness check (\w+):/g)].map(
      (match) => match[1],
    );
    expect(listedChecks.sort()).toEqual(failing.map((check) => check.id).sort());
    for (const check of failing) {
      expect(prompt).toContain(check.fix_hint as string);
    }
    expect(prompt).not.toMatch(/\[error\]/);
    expect(prompt).toContain(state.targetToken);
    expect(prompt).toContain(SCHEMA_URL);
    expect(prompt).toContain("70");
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
    await dialog.getByRole("button", { name: "Copy Fix-up prompt" }).click();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard.replace(/\r\n/g, "\n")).toBe(prompt);

    const issues = await apiGet<{
      items: { template_name: string; text: string; params: { bundle_id?: string } }[];
    }>(page, `/api/v1/targets/${state.targetId}/prompt-issues?template_name=fixup`);
    expect(issues.body.items).toHaveLength(1);
    expect(issues.body.items[0]?.params.bundle_id).toBe(bundle.id);
    expect(issues.body.items[0]?.text.replace(/\r\n/g, "\n")).toBe(prompt);
  });

  test("gracie_like.zip is version 2, valid with 100, and its diff against version 1 has added and removed features", async ({
    page,
  }) => {
    await openIntake(page);

    const upload = await uploadFixture(page, "gracie_like.zip");

    expect(upload.status).toBe(201);
    const bundle = upload.body.bundle as BundleView;
    expect(bundle).toMatchObject({ version: 2, validation_status: "valid", feature_count: 4 });
    expect(bundle.completeness).toMatchObject({ score: 100, status: "meets_bar" });
    expect(bundle.diff_summary).toMatchObject({
      against_version: 1,
      features_added: 4,
      features_removed: 1,
      features_changed: 0,
    });
    await expect(result(page).getByRole("heading", { name: "Version 2 created" })).toBeVisible();
    await expect(result(page)).toContainText("Meets bar");
    await expect(result(page)).toContainText("Score 100 of 100, bar 80");
    await expect(result(page)).toContainText(
      "Compared with version 1: 4 added, 1 removed, 0 changed.",
    );
    await expect(result(page).getByRole("link", { name: "View the catalog" })).toBeVisible();

    await result(page).getByRole("link", { name: "Open version 2" }).click();
    const changes = page.getByRole("region", { name: "Changes" });
    await expect(changes).toContainText("Compared with version 1");
    const added = changes.locator("[data-change='added']");
    await expect(added).toHaveCount(4);
    await expect(changes.locator("[data-change='removed']")).toHaveCount(1);
    await expect(
      changes.locator("[data-feature='notes.read.list'][data-change='removed']"),
    ).toBeVisible();
    await expect(
      changes.locator("[data-feature='smart_log.write.create_issue'][data-change='added']"),
    ).toBeVisible();
  });

  test("gracie_like_changed.zip is version 3 with one added and one changed feature; a lost response is retried with the same key and replayed", async ({
    page,
  }) => {
    const keys: string[] = [];
    let attempts = 0;
    await page.route(`${apiOrigin()}/api/v1/bundles`, async (route) => {
      const request = route.request();
      if (request.method() !== "POST") {
        await route.fallback();
        return;
      }
      keys.push((await request.allHeaders())["idempotency-key"] ?? "");
      attempts += 1;
      if (attempts === 1) {
        await route.fetch();
        await route.abort("connectionreset");
        return;
      }
      await route.continue();
    });
    await openIntake(page);
    await chooseFixture(page, "gracie_like_changed.zip");
    await page.getByRole("button", { name: "Upload and validate" }).click();

    await expect(failure(page)).toContainText("Cannot reach the Tessa API");
    await expect(failure(page)).not.toContainText("Nothing was stored");
    expect(await listVersions(page)).toEqual([1, 2, 3]);
    const replayed = page.waitForResponse(isBundlePost);
    await page.getByRole("button", { name: "Try again" }).click();
    const response = await replayed;

    expect(response.status()).toBe(201);
    expect(response.headers()["idempotency-replayed"]).toBe("true");
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    const body = await parseBody(response);
    const bundle = body.bundle as BundleView;
    expect(bundle).toMatchObject({ version: 3, validation_status: "valid", feature_count: 5 });
    expect(bundle.completeness.score).toBe(100);
    expect(bundle.diff_summary).toMatchObject({
      against_version: 2,
      features_added: 1,
      features_removed: 0,
      features_changed: 1,
    });
    state.bundleIds.set(3, bundle.id);
    state.expectedVersions.push(3);
    await expect(result(page).getByRole("heading", { name: "Version 3 created" })).toBeVisible();
    await expect(result(page)).toContainText(
      "Compared with version 2: 1 added, 0 removed, 1 changed.",
    );
    await expect(versionsTable(page).getByRole("link")).toHaveCount(3);
    expect(await listVersions(page)).toEqual([1, 2, 3]);

    await result(page).getByRole("link", { name: "Open version 3" }).click();
    const changes = page.getByRole("region", { name: "Changes" });
    await expect(changes).toContainText("Compared with version 2");
    await expect(changes.locator("[data-change='added']")).toHaveCount(1);
    await expect(
      changes.locator("[data-feature='rooms.read.list'][data-change='added']"),
    ).toBeVisible();
    await expect(changes.locator("[data-change='changed']")).toHaveCount(1);
    const changed = changes.locator("[data-feature='smart_log.read.open_maintenance']");
    await expect(changed).toHaveAttribute("data-change", "changed");
    await expect(changed).toContainText("description");
    await expect(changed).toContainText("per room or floor");
    await expect(changes.locator("[data-change='removed']")).toHaveCount(0);
  });

  test("backslash_paths.zip has the content of version 2 and is reported as identical without a new version", async ({
    page,
  }) => {
    await openIntake(page);

    const upload = await uploadFixture(page, "backslash_paths.zip");

    expect(upload.status).toBe(200);
    expect(upload.body.created).toBe(false);
    const bundle = upload.body.bundle as BundleView;
    expect(bundle.version).toBe(2);
    await expect(
      result(page).getByRole("heading", { name: "Identical to version 2" }),
    ).toBeVisible();
    await expectNothingStoredSince(page);
  });

  test("choosing gracie_like.zip again is reported as identical to version 2", async ({ page }) => {
    await openIntake(page);

    const upload = await uploadFixture(page, "gracie_like.zip");

    expect(upload.status).toBe(200);
    expect(upload.body.created).toBe(false);
    expect(upload.body.bundle?.version).toBe(2);
    await expect(
      result(page).getByRole("heading", { name: "Identical to version 2" }),
    ).toBeVisible();
    await expectNothingStoredSince(page);
  });

  test("missing_sections.zip is stored invalid with the errors first and no catalog link", async ({
    page,
  }) => {
    await openIntake(page);

    const upload = await uploadFixture(page, "missing_sections.zip");

    expect(upload.status).toBe(201);
    const bundle = upload.body.bundle as BundleView;
    expect(bundle).toMatchObject({ version: 4, validation_status: "invalid" });
    expect(bundle.errors.length).toBeGreaterThan(0);
    await expect(
      result(page).getByRole("heading", { name: "Version 4 stored with errors" }),
    ).toBeVisible();
    await expect(result(page)).toContainText("Invalid");
    await expect(result(page).getByRole("link", { name: "View the catalog" })).toHaveCount(0);

    await result(page).getByRole("link", { name: "Open version 4" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Validation errors" })).toBeVisible();
    const headings = await page.getByRole("heading", { level: 2 }).allTextContents();
    expect(headings.slice(0, 3)).toEqual(["Version 4", "Validation errors", "Completeness"]);
    await expect(page.getByRole("region", { name: "Problems in manifest.yaml" })).toContainText(
      "required",
    );
    await expect(page.getByRole("link", { name: "View the catalog" })).toHaveCount(0);
    await expect(
      page.getByText("No catalog was built from this version because it is invalid."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Generate Fix-up prompt" })).toHaveAttribute(
      "data-variant",
      "default",
    );
    const catalog = await apiGet<{ bundle_version: number | null }>(
      page,
      `/api/v1/catalog?target_id=${state.targetId}&bundle_id=${bundle.id}`,
    );
    expect(catalog.status).toBe(200);
    expect(catalog.body.bundle_version).toBe(4);
    const fallback = await apiGet<{ bundle_version: number | null }>(
      page,
      `/api/v1/catalog?target_id=${state.targetId}`,
    );
    expect(fallback.body.bundle_version).toBe(3);
  });

  test("secret_bearing.zip is refused with a findings table and nothing is stored, in the database or on disk", async ({
    page,
  }) => {
    await openIntake(page);
    const versionsBefore = await listVersions(page);

    const upload = await uploadFixture(page, "secret_bearing.zip");

    expect(upload.status).toBe(422);
    expect(upload.body.error?.code).toBe("bundle_contains_secret");
    const alert = failure(page);
    await expect(
      alert.getByRole("heading", { name: "The bundle contains what look like secrets" }),
    ).toBeVisible();
    await expect(alert).toContainText("Nothing was stored");
    const table = alert.getByRole("table", { name: "Secrets found" });
    const envRow = table.getByRole("row", { name: /env\.template/ });
    await expect(envRow).toContainText(/\d+/);
    await expect(envRow).toContainText("[REDACTED]");
    const scriptRow = table.getByRole("row", { name: /seeds\/hash\.sh/ });
    await expect(scriptRow).toContainText("[REDACTED]");
    expect(await table.getByRole("row").count()).toBeGreaterThanOrEqual(3);
    const pageText = await page.locator("body").innerText();
    expect(pageText).not.toContain(LEAKED_GITHUB_TOKEN);
    expect(pageText).not.toContain(LEAKED_DB_PASSWORD);

    expect(await listVersions(page)).toEqual(versionsBefore);
    await expectNothingStoredSince(page);
    const stored = filesUnder(path.join(apiDataDirectory(), "bundles", state.targetId));
    for (const file of stored) {
      const text = readFileSync(file, "utf8");
      expect(text.includes(LEAKED_GITHUB_TOKEN), file).toBe(false);
      expect(text.includes(LEAKED_DB_PASSWORD), file).toBe(false);
    }
  });

  test("zip_slip.zip is rejected as an unsafe archive and nothing is stored", async ({ page }) => {
    await openIntake(page);

    const upload = await uploadFixture(page, "zip_slip.zip");

    expect(upload.status).toBe(422);
    expect(upload.body.error?.code).toBe("validation_failed");
    await expect(failure(page)).toHaveAttribute("data-failure", "archive_rejected");
    await expect(failure(page)).toHaveAttribute("data-code", "unsafe_path");
    await expectNothingStoredSince(page);
  });

  test("zip_bomb.zip is refused as too large and nothing is stored", async ({ page }) => {
    await openIntake(page);

    const upload = await uploadFixture(page, "zip_bomb.zip");

    expect(upload.status).toBe(413);
    await expect(failure(page)).toHaveAttribute("data-failure", "too_large");
    await expectNothingStoredSince(page);
  });

  test("the version list and the detail of version 2 show the checks, missing hooks and a nested file", async ({
    page,
  }) => {
    await page.goto(intakeUrl());
    const table = versionsTable(page);
    await expect(table.getByRole("link")).toHaveCount(4);
    expect(await table.getByRole("link").allTextContents()).toEqual([
      "Version 4",
      "Version 3",
      "Version 2",
      "Version 1",
    ]);
    await expect(table.getByRole("row", { name: /Version 4/ })).toContainText("Invalid");
    await expect(table.getByRole("row", { name: /Version 3/ })).toContainText("100 of 100");
    await expect(table.getByRole("row", { name: /Version 1/ })).toContainText("Below bar");
    await expect(page.getByText("Showing 4 of 4 versions")).toBeVisible();

    await page.getByRole("link", { name: "Version 2", exact: true }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Version 2" })).toBeVisible();
    await expect(page.getByRole("meter", { name: "Completeness score" })).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
    await expect(page.getByText("Bar 80")).toBeVisible();
    const weights: Record<string, number> = {
      required_sections: 20,
      feature_interface_roles: 15,
      feature_examples: 20,
      oracle_read_only: 15,
      env_template_coverage: 15,
      seeds_reset_and_hash: 15,
    };
    for (const [id, weight] of Object.entries(weights)) {
      await expect(page.locator(`[data-check='${id}']`)).toContainText(`${weight} of ${weight}`);
    }
    await expect(page.getByRole("region", { name: "Missing test hooks" })).toContainText(
      "pin_clock",
    );
    await expect(page.getByRole("region", { name: "Missing test hooks" })).toContainText(
      "flush_cache",
    );

    const files = page.getByRole("region", { name: "Files" });
    await expect(files.getByRole("heading", { level: 3, name: "manifest.yaml" })).toBeVisible();
    await expect(files.locator("pre")).toContainText("schema:");
    await files.getByRole("button", { name: "Preview seeds/reset.sql" }).click();
    await expect(files.getByRole("heading", { level: 3, name: "seeds/reset.sql" })).toBeVisible();
    await expect(files.locator("pre")).not.toHaveText("");
    const resetSql = readFileSync(
      path.join(
        process.cwd(),
        "..",
        "api",
        "tests",
        "fixtures",
        "bundle_examples",
        "gracie",
        "seeds",
        "reset.sql",
      ),
      "utf8",
    );
    const firstLine = resetSql.split("\n").find((line) => line.trim() !== "") ?? "";
    await expect(files.locator("pre")).toContainText(firstLine.trim());
    await expect(files.getByRole("note")).toHaveCount(0);
  });
});

test.describe("c. catalog", () => {
  const FEATURES = [
    "smart_log.read.open_maintenance",
    "smart_log.write.create_issue",
    "auth.login.staff",
    "admin.users.list",
    "rooms.read.list",
  ];

  function cards(page: Page): Locator {
    return page.getByRole("article");
  }

  async function openCatalog(page: Page, search = ""): Promise<void> {
    await page.goto(`/catalog?target_id=${state.targetId}${search}`);
    await expect(page.getByRole("search", { name: "Filter features" })).toBeVisible({
      timeout: SETTLE_TIMEOUT_MS,
    });
  }

  async function chooseFilter(page: Page, filter: string, option: string): Promise<void> {
    await page.getByRole("button", { name: new RegExp(`^${filter}: `) }).click();
    await page.getByRole("checkbox", { name: option, exact: true }).check();
    await page.keyboard.press("Escape");
  }

  test("lists the areas and every feature with its kind, interfaces, roles, flag, confidence and examples", async ({
    page,
  }) => {
    await openCatalog(page);

    await expect(page.getByRole("heading", { level: 1, name: "Catalog" })).toBeVisible();
    await expect(page.getByText("Bundle version 3")).toBeVisible();
    await expect(cards(page)).toHaveCount(5);
    await expect(page.getByText(/5 features in 4 areas$/)).toBeVisible();
    const areaHeadings = await page
      .getByRole("heading", { level: 2 })
      .filter({ hasText: / features?$/ })
      .allTextContents();
    expect(areaHeadings).toEqual([
      "Admin 1 feature",
      "Auth 1 feature",
      "Rooms 1 feature",
      "Smart Log 2 features",
    ]);
    for (const id of FEATURES) {
      await expect(page.getByRole("article", { name: id })).toBeVisible();
    }

    const write = page.getByRole("article", { name: "smart_log.write.create_issue" });
    await expect(write.getByText("Write", { exact: true })).toBeVisible();
    await expect(write.getByText("Medium confidence")).toBeVisible();
    await expect(write.getByRole("list", { name: "Interfaces" })).toContainText("chat_sse");
    await expect(write.getByRole("list", { name: "Interfaces" })).toContainText("browser");
    await expect(write.getByRole("list", { name: "Roles" })).toContainText("staff");
    await expect(write.getByRole("list", { name: "Roles" })).toContainText("manager");
    await expect(write.getByRole("list", { name: "Flag" })).toContainText("confirmation_gate");
    await write.getByRole("button", { name: /^Details of / }).click();
    await expect(write.getByRole("region", { name: "Preconditions" })).toContainText(
      "seed.smart_log_history",
    );
    await expect(write.getByRole("region", { name: "Examples (1)" })).toContainText(
      "Create a maintenance issue for room 20003",
    );
    await expect(write.getByRole("region", { name: "Cleanup" })).toContainText(
      "delete the issue created by the run",
    );
    const writes = write.getByRole("region", { name: "Write details" });
    await expect(writes).toContainText("smart_log_issue");
    await expect(writes).toContainText("button-only, typed yes accepted");
    await expect(writes).toContainText("room_number");

    const read = page.getByRole("article", { name: "smart_log.read.open_maintenance" });
    await expect(read.getByText("Read", { exact: true })).toBeVisible();
    await expect(read.getByText("High confidence")).toBeVisible();
    await expect(read.getByRole("list", { name: "Roles" })).toContainText("All roles");
    await read.getByRole("button", { name: /^Details of / }).click();
    await expect(read.getByRole("region", { name: "Examples (2)" })).toContainText(
      "Which maintenance issues are still open?",
    );
    await expect(read.getByRole("region", { name: "Examples (2)" })).toContainText(
      "open_maintenance",
    );
  });

  test("filters live in the URL: area, kind, role (including all), confidence, interface and q", async ({
    page,
  }) => {
    await openCatalog(page);

    await chooseFilter(page, "Kind", "Write");
    await expect(cards(page)).toHaveCount(1);
    await expect(page).toHaveURL(new RegExp(`target_id=${state.targetId}&kind=write$`));
    await page.reload();
    await expect(cards(page)).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Kind: 1 selected" })).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).first().click();
    await expect(cards(page)).toHaveCount(5);

    await chooseFilter(page, "Role", "manager");
    await expect(page).toHaveURL(/role=manager/);
    await expect(cards(page)).toHaveCount(3);
    expect((await page.locator("article h3").allTextContents()).sort()).toEqual(
      ["rooms.read.list", "smart_log.read.open_maintenance", "smart_log.write.create_issue"].sort(),
    );
    await expect(page.getByRole("article", { name: "auth.login.staff" })).toHaveCount(0);
    await expect(page.getByRole("article", { name: "admin.users.list" })).toHaveCount(0);
    await page.getByRole("button", { name: "Clear filters" }).first().click();

    await chooseFilter(page, "Role", "admin");
    await expect(page.getByRole("article", { name: "admin.users.list" })).toBeVisible();
    await expect(
      page.getByRole("article", { name: "smart_log.read.open_maintenance" }),
    ).toBeVisible();
    await expect(cards(page)).toHaveCount(3);
    await page.getByRole("button", { name: "Clear filters" }).first().click();

    await chooseFilter(page, "Area", "Smart Log");
    await chooseFilter(page, "Confidence", "High");
    await expect(page).toHaveURL(/area=Smart\+Log/);
    await expect(page).toHaveURL(/confidence=high/);
    await expect(cards(page)).toHaveCount(1);
    await expect(
      page.getByRole("article", { name: "smart_log.read.open_maintenance" }),
    ).toBeVisible();
    await page.getByRole("searchbox", { name: "Search" }).fill("zzz-no-such-thing");
    await expect(page.getByRole("heading", { name: "No features match" })).toBeVisible();
    await expect(page).toHaveURL(/q=zzz-no-such-thing/);
    await page.getByRole("main").getByRole("button", { name: "Clear filters" }).first().click();
    await expect(cards(page)).toHaveCount(5);
    await expect(page).toHaveURL(new RegExp(`/catalog\\?target_id=${state.targetId}$`));

    await chooseFilter(page, "Interface", "admin_api");
    await expect(cards(page)).toHaveCount(1);
    await expect(page.getByRole("article", { name: "admin.users.list" })).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).first().click();

    await page.getByRole("searchbox", { name: "Search" }).fill("maintenance");
    await expect(cards(page)).toHaveCount(2);
    await expect(page).toHaveURL(/q=maintenance/);

    await page.goto(
      `/catalog?target_id=${state.targetId}&area=Smart+Log&kind=read&role=staff&confidence=high&q=open`,
    );
    await expect(page.getByRole("search", { name: "Filter features" })).toBeVisible();
    await expect(cards(page)).toHaveCount(1);
    await expect(
      page.getByRole("article", { name: "smart_log.read.open_maintenance" }),
    ).toBeVisible();
  });

  test("the API filters agree with the UI, including repeated parameters", async ({ page }) => {
    const ids = async (query: string) => {
      const response = await apiGet<{
        areas: { items: { feature_id: string }[] }[];
      }>(page, `/api/v1/catalog?target_id=${state.targetId}${query}`);
      expect(response.status).toBe(200);
      return response.body.areas
        .flatMap((area) => area.items.map((item) => item.feature_id))
        .sort();
    };

    expect(await ids("")).toEqual([...FEATURES].sort());
    expect(await ids("&kind=read&kind=write")).toEqual(
      ["rooms.read.list", "smart_log.read.open_maintenance", "smart_log.write.create_issue"].sort(),
    );
    expect(await ids("&role=staff")).toEqual(
      [
        "auth.login.staff",
        "rooms.read.list",
        "smart_log.read.open_maintenance",
        "smart_log.write.create_issue",
      ].sort(),
    );
    expect(await ids("&confidence=medium&confidence=low")).toEqual(
      ["admin.users.list", "rooms.read.list", "smart_log.write.create_issue"].sort(),
    );
    expect(await ids("&q=OPEN")).toEqual(["smart_log.read.open_maintenance"]);
  });

  test("a target with no valid bundle gets 200 with null ids and the intake call to action", async ({
    page,
  }) => {
    const created = await apiRequest<{ id: string }>(page, "POST", "/api/v1/targets", {
      data: { name: "Empty", app_kind: "web" },
    });
    expect(created.status).toBe(201);
    const emptyId = created.body.id;

    const catalog = await apiGet<{
      bundle_id: string | null;
      bundle_version: number | null;
      areas: unknown[];
      roles: unknown[];
      interfaces: unknown[];
    }>(page, `/api/v1/catalog?target_id=${emptyId}`);
    expect(catalog.status).toBe(200);
    expect(catalog.body).toMatchObject({
      bundle_id: null,
      bundle_version: null,
      areas: [],
      roles: [],
      interfaces: [],
    });

    await page.goto(`/catalog?target_id=${emptyId}`);
    await expect(page.getByRole("heading", { name: "No valid bundle yet" })).toBeVisible();
    await expect(page.getByRole("search")).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    await page.getByRole("link", { name: "Upload a bundle" }).click();
    await expect(page).toHaveURL(new RegExp(`/targets/${emptyId}/bundles$`));
    await expect(page.getByRole("heading", { level: 2, name: "Add a version" })).toBeVisible();

    const unknown = await apiGet<{ error: { code: string } }>(
      page,
      "/api/v1/catalog?target_id=0198f6f2-4c2a-7d10-9c1e-6a4f0d3b9999",
    );
    expect(unknown.status).toBe(404);
  });

  test("an explicit invalid bundle id echoes the ids and links to the errors", async ({ page }) => {
    const invalidId = state.bundleIds.get(4) as string;
    await page.goto(`/catalog?target_id=${state.targetId}&bundle_id=${invalidId}`);

    await expect(page.getByRole("heading", { name: "This bundle has no catalog" })).toBeVisible();
    await expect(page.getByText("Version 4 did not validate")).toBeVisible();
  });
});

test.describe("d and e. environment, health ticks and secrets", () => {
  test.setTimeout(120_000);

  const secrets = {
    staffPassword: `dev-only-staff-pw-${RUN_ID}`,
    managerToken: `dev-only-manager-token-${RUN_ID}`,
    adminToken: `dev-only-admin-token-${RUN_ID}`,
    seedPassword: `dev-only-seed-pw-${RUN_ID}`,
    mysqlTruthPassword: `dev-only-mysql-truth-pw-${RUN_ID}`,
  };

  function mysqlDsn(user: string, password: string): string {
    return `mysql://${user}:${password}@127.0.0.1:3306/gracie`;
  }

  function typedSecrets(): string[] {
    return [
      secrets.staffPassword,
      secrets.managerToken,
      secrets.adminToken,
      truthDatabase.dsn,
      truthDatabase.password,
      mysqlDsn("seed_writer", secrets.seedPassword),
      secrets.seedPassword,
      mysqlDsn("truth_reader", secrets.mysqlTruthPassword),
      secrets.mysqlTruthPassword,
    ];
  }

  test("lists the variables of env.template, masks secrets and flags the missing required ones", async ({
    page,
  }) => {
    await openEnvironment(page);

    await expect(page.getByRole("heading", { level: 1, name: "Gracie" })).toBeVisible();
    for (const name of [
      "GRACIE_BASE_URL",
      "STAFF_EMAIL",
      "STAFF_PASSWORD",
      "MANAGER_TOKEN",
      "ADMIN_TOKEN",
      "SMART_LOG_TENANT_ID",
      "TRUTH_DB_DSN",
      "SEED_DB_DSN",
    ]) {
      await expect(variable(page, name)).toBeVisible();
    }
    for (const name of [
      "STAFF_PASSWORD",
      "MANAGER_TOKEN",
      "ADMIN_TOKEN",
      "TRUTH_DB_DSN",
      "SEED_DB_DSN",
    ]) {
      await expect(field(page, name)).toHaveAttribute("type", "password");
      await expect(field(page, name)).toHaveAttribute("autocomplete", "off");
      await expect(field(page, name)).toHaveValue("");
    }
    await expect(field(page, "GRACIE_BASE_URL")).toHaveAttribute("type", /text|url/);
    const banner = page.locator("[data-slot=missing-required-banner]");
    await expect(banner).toContainText("7 required variables have no value");
    for (const name of [
      "GRACIE_BASE_URL",
      "STAFF_EMAIL",
      "STAFF_PASSWORD",
      "MANAGER_TOKEN",
      "ADMIN_TOKEN",
      "SMART_LOG_TENANT_ID",
      "TRUTH_DB_DSN",
    ]) {
      await expect(banner).toContainText(name);
      await expect(variable(page, name).getByText("Not set", { exact: true })).toBeVisible();
    }
    await expect(banner).not.toContainText("SEED_DB_DSN");
    const stale = page.getByRole("region", { name: "Not used by the latest bundle" });
    await expect(stale).toContainText("NOTES_BASE_URL");
    await expect(stale.getByText("Stale")).toHaveCount(1);
    await expect(page.getByText("No health check has run yet.")).toBeVisible();
    expect(countStoredValues(state.targetId)).toBe(0);
  });

  test("fills every required variable, saves and every supported interface is ok; typed secrets never come back", async ({
    page,
  }) => {
    const traffic = recordTraffic(page);
    await openEnvironment(page);
    await field(page, "GRACIE_BASE_URL").fill(fakeTarget.origin);
    await field(page, "STAFF_EMAIL").fill("staff.qa@example.test");
    await field(page, "STAFF_PASSWORD").fill(secrets.staffPassword);
    await field(page, "MANAGER_TOKEN").fill(secrets.managerToken);
    await field(page, "ADMIN_TOKEN").fill(secrets.adminToken);
    await field(page, "SMART_LOG_TENANT_ID").fill(`qa-property-${RUN_ID}`);
    await field(page, "TRUTH_DB_DSN").fill(truthDatabase.dsn);

    await saveButton(page).click();

    await expect(page.getByText("Saved: 7 values set.")).toBeVisible();
    await expect(page.locator("[data-slot=missing-required-banner]")).toHaveCount(0);
    await expectNoSecretInBrowser(page, typedSecrets());
    for (const name of ["STAFF_PASSWORD", "TRUTH_DB_DSN", "ADMIN_TOKEN"]) {
      await expect(variable(page, name).getByText("Set", { exact: true })).toBeVisible();
      await expect(field(page, name)).toHaveValue("");
    }
    await expect(field(page, "GRACIE_BASE_URL")).toHaveValue(fakeTarget.origin);
    expect(countStoredValues(state.targetId)).toBe(7);

    await runHealthChecks(page);

    for (const id of ["chat_sse", "browser", "admin_api", "truth:primary_db"]) {
      await expect(healthRow(page, id)).toHaveAttribute("data-status", "ok");
    }
    await expect(variable(page, "GRACIE_BASE_URL").getByText("OK", { exact: true })).toBeVisible();
    expect(fakeTarget.requests).toContain("GET /health");
    await expectNoSecretInBrowser(page, typedSecrets());

    const report = await apiGet<{ checked_at: string | null; interfaces: HealthRowView[] }>(
      page,
      `/api/v1/targets/${state.targetId}/health`,
    );
    expect(report.status).toBe(200);
    expect(report.body.checked_at).not.toBeNull();
    expect(
      report.body.interfaces.map((entry) => `${entry.interface_id}:${entry.status}`).sort(),
    ).toEqual(["admin_api:ok", "browser:ok", "chat_sse:ok", "truth:primary_db:ok"].sort());

    await page.reload();
    await expect(page.getByRole("list", { name: "Interface health" })).toBeVisible();
    await expect(healthRow(page, "chat_sse")).toHaveAttribute("data-status", "ok");
    await expectNoSecretInBrowser(page, typedSecrets());

    const bodies = await expectNoSecretInTraffic(traffic, typedSecrets());
    expect(bodies).toBeGreaterThan(8);
    const everyBody = await traffic.responseBodies();
    expect(
      everyBody.some(
        (body) => body.url.startsWith(apiOrigin()) && body.text.includes(fakeTarget.origin),
      ),
      "the recorder reads API bodies (the plain URL value comes back)",
    ).toBe(true);
    expect(
      everyBody.some(
        (body) =>
          body.url.endsWith(`/targets/${state.targetId}/environment`) &&
          body.text.includes("<html") &&
          body.text.includes("self.__next_f"),
      ),
      "the recorder reads the page document with its RSC payload",
    ).toBe(true);
  });

  test("a wrong URL fails with a message and a non-Postgres DSN is skipped with a reason", async ({
    page,
  }) => {
    const traffic = recordTraffic(page);
    const closedOrigin = await unusedPortOrigin();
    await openEnvironment(page);
    await field(page, "GRACIE_BASE_URL").fill(closedOrigin);
    await field(page, "SEED_DB_DSN").fill(mysqlDsn("seed_writer", secrets.seedPassword));
    await field(page, "TRUTH_DB_DSN").fill(mysqlDsn("truth_reader", secrets.mysqlTruthPassword));
    await saveButton(page).click();
    await expect(page.getByText("Saved: 3 values set.")).toBeVisible();

    await runHealthChecks(page);

    for (const id of ["chat_sse", "browser", "admin_api"]) {
      await expect(healthRow(page, id)).toHaveAttribute("data-status", "failed");
      await expect(healthRow(page, id)).toContainText(/refused|unreachable|connect|could not/i);
    }
    await expect(healthRow(page, "truth:primary_db")).toHaveAttribute("data-status", "skipped");
    await expect(
      variable(page, "GRACIE_BASE_URL").getByText("Failed", { exact: true }),
    ).toBeVisible();
    const report = await apiGet<{ interfaces: HealthRowView[] }>(
      page,
      `/api/v1/targets/${state.targetId}/health`,
    );
    const byId = new Map(report.body.interfaces.map((entry) => [entry.interface_id, entry]));
    expect(byId.get("chat_sse")?.status).toBe("failed");
    expect(byId.get("chat_sse")?.message).toBeTruthy();
    expect(byId.get("truth:primary_db")?.status).toBe("skipped");
    expect(byId.get("truth:primary_db")?.message).toBeTruthy();
    await expect(healthRow(page, "truth:primary_db")).toContainText(
      byId.get("truth:primary_db")?.message ?? "",
    );
    const environment = await apiGet<{
      items: { name: string; health: { status: string; message: string | null } }[];
    }>(page, `/api/v1/targets/${state.targetId}/environment`);
    const healthOf = (name: string) =>
      environment.body.items.find((item) => item.name === name)?.health;
    expect(healthOf("TRUTH_DB_DSN")?.status).toBe("skipped");
    expect(healthOf("TRUTH_DB_DSN")?.message).toBeTruthy();
    expect(healthOf("GRACIE_BASE_URL")?.status).toBe("failed");
    expect(healthOf("SEED_DB_DSN")?.status).toBe("unchecked");

    await field(page, "GRACIE_BASE_URL").fill(fakeTarget.origin);
    await field(page, "TRUTH_DB_DSN").fill(truthDatabase.dsn);
    await saveButton(page).click();
    await expect(page.getByText("Saved: 2 values set.")).toBeVisible();
    await runHealthChecks(page);
    for (const id of ["chat_sse", "browser", "admin_api", "truth:primary_db"]) {
      await expect(healthRow(page, id)).toHaveAttribute("data-status", "ok");
    }

    await expectNoSecretInBrowser(page, typedSecrets());
    await page.reload();
    await expect(page.getByRole("list", { name: "Interface health" })).toBeVisible();
    await expectNoSecretInBrowser(page, typedSecrets());
    expect(await expectNoSecretInTraffic(traffic, typedSecrets())).toBeGreaterThan(8);
    state.typedSecrets = typedSecrets();
  });

  test("the typed secrets are in no server log and the vault holds only ciphertext", async ({
    page,
  }) => {
    expect(state.typedSecrets.length).toBeGreaterThan(0);

    const logs = expectNoSecretInServerLogs(state.typedSecrets);

    expect(logs.files, "set E2E_LOG_FILES to the API and worker logs").toBeGreaterThan(0);
    expect(logs.characters, "the logs are not empty").toBeGreaterThan(1000);
    expect(countStoredValues(state.targetId)).toBe(8);
    expectNoPlaintextInVault(state.targetId, state.typedSecrets);
    const environment = await apiGet<{ items: Record<string, unknown>[] }>(
      page,
      `/api/v1/targets/${state.targetId}/environment`,
    );
    const text = JSON.stringify(environment.body);
    for (const secret of state.typedSecrets) {
      expect(text.includes(secret)).toBe(false);
    }
    const secretItems = environment.body.items.filter((item) => item.secret === true);
    expect(secretItems.length).toBeGreaterThan(0);
    for (const item of secretItems) {
      expect(item.value ?? null).toBeNull();
    }
  });
});

test.describe("b. paste dialog", () => {
  test("paste_only.manifest.yaml is accepted as the next version and scores 55, below the bar", async ({
    page,
  }) => {
    await openIntake(page);
    const manifest = readFileSync(fixtures().path("paste_only.manifest.yaml"), "utf8");
    await page.getByRole("button", { name: "Paste manifest instead" }).click();
    const dialog = page.getByRole("dialog", { name: "Paste manifest.yaml" });
    await expect(dialog.getByRole("button", { name: "Add version" })).toBeDisabled();
    await dialog.getByLabel("manifest.yaml").fill(manifest);
    await dialog.getByLabel("Note (optional)").fill("pasted without the sibling files");
    const responded = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/v1/bundles/paste",
    );

    await dialog.getByRole("button", { name: "Add version" }).click();
    const response = await responded;

    expect(response.status()).toBe(201);
    expect(response.request().headers()["idempotency-key"]).toBeTruthy();
    const body = (await response.json()) as { bundle: BundleView; created: boolean };
    expect(body.created).toBe(true);
    expect(body.bundle).toMatchObject({
      version: 5,
      validation_status: "valid",
      source: "manifest_paste",
    });
    expect(body.bundle.completeness).toMatchObject({ score: 55, status: "below_bar" });
    state.bundleIds.set(5, body.bundle.id);
    state.expectedVersions.push(5);
    await expect(dialog).toHaveCount(0);
    await expect(result(page).getByRole("heading", { name: "Version 5 created" })).toBeVisible();
    await expect(result(page)).toContainText("Below bar");
    await expect(result(page)).toContainText("Score 55 of 100, bar 80");
    await expect(versionsTable(page).getByText("Pasted manifest")).toBeVisible();
    expect(await listVersions(page)).toEqual([1, 2, 3, 4, 5]);

    await result(page).getByRole("link", { name: "Open version 5" }).click();
    await expect(page.getByText("Note: pasted without the sibling files")).toBeVisible();
    const detail = await readBundle(page, body.bundle.id);
    const earned = Object.fromEntries(
      detail.completeness.checks.map((check) => [check.id, check.earned]),
    );
    expect(earned.oracle_read_only).toBe(0);
    expect(earned.env_template_coverage).toBe(0);
    expect(earned.seeds_reset_and_hash).toBe(0);
    await expect(page.getByRole("button", { name: "Generate Fix-up prompt" })).toHaveAttribute(
      "data-variant",
      "default",
    );
  });
});
