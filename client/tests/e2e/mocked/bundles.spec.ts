import path from "node:path";
import { expect, test, type Page, type Request } from "@playwright/test";
import {
  GRACIE_SEEDED_BRANCH,
  GRACIE_SEEDED_COMMIT_SHA,
  STAGE_ONE_IDS,
} from "../../../mocks/stage1/seed";
import { expectNoAxeViolations } from "../helpers/axe";
import { apiOrigin } from "../helpers/env";
import { clearMockFaults, resetMockApi } from "../helpers/mock-api";

const GRACIE = STAGE_ONE_IDS.gracie;
const BILLING = STAGE_ONE_IDS.billing;
const BROKEN_IMPORT = STAGE_ONE_IDS.brokenImport;
const FIXTURE_DIRECTORY = path.join(process.cwd(), "tests", "fixtures", "bundles");
const MAX_TABS = 40;

function fixture(name: string): string {
  return path.join(FIXTURE_DIRECTORY, name);
}

function intakeUrl(targetId: string): string {
  return `/targets/${targetId}/bundles`;
}

async function openIntake(page: Page, targetId: string): Promise<void> {
  await page.goto(intakeUrl(targetId));
  await expect(page.getByRole("heading", { level: 2, name: "Add a version" })).toBeVisible();
  await expect(page.getByLabel("Bundle zip")).toBeEnabled();
  await expect(page.getByText(/at most [\d.]+ (B|KiB|MiB)/)).toBeVisible();
}

async function chooseFixture(page: Page, name: string): Promise<void> {
  await page.getByLabel("Bundle zip").setInputFiles(fixture(name));
  await expect(page.getByRole("group", { name: "File ready to upload" })).toContainText(name);
}

async function uploadFixture(page: Page, name: string): Promise<void> {
  await chooseFixture(page, name);
  await page.getByRole("button", { name: "Upload and validate" }).click();
}

function result(page: Page) {
  return page.getByRole("region", { name: "Upload result" });
}

function failure(page: Page) {
  return page.getByRole("alert", { name: "Upload failed" });
}

async function openVersion(page: Page, targetId: string, version: number): Promise<void> {
  await page.goto(intakeUrl(targetId));
  await page.getByRole("link", { name: `Version ${version}`, exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: `Version ${version}` })).toBeVisible();
}

function isBundlePost(request: Request): boolean {
  return request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/bundles";
}

async function tabTo(page: Page, target: ReturnType<Page["locator"]>): Promise<void> {
  for (let presses = 0; presses < MAX_TABS; presses += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement)) {
      return;
    }
  }
  throw new Error("the element was not reached with the Tab key");
}

test.describe("bundle intake", () => {
  test.beforeEach(async ({ request }) => {
    await resetMockApi(request);
  });

  test.afterEach(async ({ request }) => {
    await clearMockFaults(request);
  });

  test("lists the versions of a target newest first and sorts them", async ({ page }) => {
    await openIntake(page, GRACIE);

    const table = page.getByRole("table", { name: "Bundle versions" });
    const versions = () => table.getByRole("link").allTextContents();
    await expect(table.getByRole("link")).toHaveCount(2);
    expect(await versions()).toEqual(["Version 2", "Version 1"]);
    await expect(table.getByRole("row", { name: /Version 2/ })).toContainText("92 of 100");
    await expect(table.getByRole("row", { name: /Version 1/ })).toContainText("Below bar");
    await expect(page.getByText("Showing 2 of 2 versions")).toBeVisible();

    await page.getByRole("button", { name: "Sort by Version" }).click();

    await expect(table.getByRole("columnheader", { name: /Version/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await expect.poll(versions).toEqual(["Version 1", "Version 2"]);
  });

  test("guides the first upload of a target without versions", async ({ page }) => {
    await openIntake(page, BILLING);

    await expect(page.getByRole("heading", { name: "No versions yet" })).toBeVisible();
    await expect(
      page.getByText("Compress-Archive -Path tessa -DestinationPath tessa.zip"),
    ).toBeVisible();
  });

  test("uploads the valid fixture as version 1, then reports the same content as identical", async ({
    page,
  }) => {
    await openIntake(page, BILLING);

    await uploadFixture(page, "valid.zip");

    await expect(result(page).getByRole("heading", { name: "Version 1 created" })).toBeVisible();
    await expect(result(page)).toContainText("Valid");
    await expect(result(page)).toContainText("Meets bar");
    await expect(result(page)).toContainText("Score 92 of 100, bar 80");
    await expect(result(page)).toContainText("First version, so there is nothing to compare with.");
    await expect(result(page).getByRole("link", { name: "View the catalog" })).toBeVisible();
    await expect(
      page.getByRole("table", { name: "Bundle versions" }).getByRole("link"),
    ).toHaveCount(1);

    await uploadFixture(page, "valid.zip");

    await expect(
      result(page).getByRole("heading", { name: "Identical to version 1" }),
    ).toBeVisible();
    await expect(
      page.getByRole("table", { name: "Bundle versions" }).getByRole("link"),
    ).toHaveCount(1);
  });

  test("sends a multipart zip part, the target, the note and one key per action", async ({
    page,
  }) => {
    const posts: Request[] = [];
    page.on("request", (request) => {
      if (isBundlePost(request)) {
        posts.push(request);
      }
    });
    await openIntake(page, BILLING);
    await chooseFixture(page, "valid.zip");
    await page.getByLabel("Note (optional)").fill("first pass");

    await page.getByRole("button", { name: "Upload and validate" }).click();
    await expect(result(page)).toBeVisible();

    expect(posts).toHaveLength(1);
    const headers = await posts[0]!.allHeaders();
    expect(headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    await expect(
      page.getByRole("table", { name: "Bundle versions" }).getByRole("link"),
    ).toHaveCount(1);
    await result(page).getByRole("link", { name: "Open version 1" }).click();
    await expect(page.getByText("Note: first pass")).toBeVisible();
  });

  test("retypes the file part as a zip even when the browser reports another type", async ({
    page,
  }) => {
    await openIntake(page, BILLING);

    await page.getByLabel("Bundle zip").setInputFiles({
      name: "tessa.zip",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(new Uint8Array(22)),
    });
    await page.getByRole("button", { name: "Upload and validate" }).click();

    await expect(result(page).getByRole("heading", { name: "Version 1 created" })).toBeVisible();
  });

  test("keeps the idempotency key when the same file is retried and changes it for another file", async ({
    page,
  }) => {
    const keys: string[] = [];
    let failuresLeft = 1;
    await page.route(`${apiOrigin()}/api/v1/bundles`, async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        keys.push((await request.allHeaders())["idempotency-key"] ?? "");
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          await route.abort("connectionreset");
          return;
        }
      }
      await route.continue();
    });
    await openIntake(page, BILLING);

    await uploadFixture(page, "below-bar.zip");

    await expect(failure(page)).toContainText("Cannot reach the Tessa API");
    await expect(failure(page)).toContainText("not known whether the upload reached the API");
    await expect(failure(page)).not.toContainText("Nothing was stored");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(result(page).getByRole("heading", { name: "Version 1 created" })).toBeVisible();
    await uploadFixture(page, "invalid.zip");
    await expect(
      result(page).getByRole("heading", { name: "Version 2 stored with errors" }),
    ).toBeVisible();

    expect(keys).toHaveLength(3);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  test("stores a below-bar version and links to its detail", async ({ page }) => {
    await openIntake(page, BILLING);

    await uploadFixture(page, "below-bar.zip");

    await expect(result(page).getByRole("heading", { name: "Version 1 created" })).toBeVisible();
    await expect(result(page)).toContainText("Below bar");
    await expect(result(page)).toContainText("Score 55 of 100, bar 80");
    await result(page).getByRole("link", { name: "Open version 1" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Version 1" })).toBeVisible();
  });

  test("stores an invalid version with its errors and no catalog link", async ({ page }) => {
    await openIntake(page, BILLING);

    await uploadFixture(page, "invalid.zip");

    await expect(
      result(page).getByRole("heading", { name: "Version 1 stored with errors" }),
    ).toBeVisible();
    await expect(result(page)).toContainText("Invalid");
    await expect(result(page)).toContainText("5 errors, 0 warnings");
    await expect(result(page).getByRole("link", { name: "View the catalog" })).toHaveCount(0);
  });

  test("reports the duplicate fixture as the latest existing version", async ({ page }) => {
    await openIntake(page, GRACIE);

    await uploadFixture(page, "duplicate.zip");

    await expect(
      result(page).getByRole("heading", { name: "Identical to version 2" }),
    ).toBeVisible();
    await expect(
      page.getByRole("table", { name: "Bundle versions" }).getByRole("link"),
    ).toHaveCount(2);
  });

  test("shows every secret finding and says nothing was stored", async ({ page }) => {
    await openIntake(page, BILLING);

    await uploadFixture(page, "secret.zip");

    await expect(
      failure(page).getByRole("heading", { name: "The bundle contains what look like secrets" }),
    ).toBeVisible();
    await expect(failure(page)).toContainText("Nothing was stored");
    const table = failure(page).getByRole("table", { name: "Secrets found" });
    await expect(table.getByRole("row")).toHaveCount(3);
    await expect(table.getByRole("row", { name: /env\.template/ })).toContainText("aws_access_key");
    await expect(table.getByRole("row", { name: /seeds\/reset\.sql/ })).toContainText("[REDACTED]");
    await expect(page.getByRole("table", { name: "Bundle versions" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "No versions yet" })).toBeVisible();
  });

  test("maps 413, 422 unknown token and 409 mismatch to their own messages", async ({ page }) => {
    await openIntake(page, BILLING);

    await uploadFixture(page, "too-large.zip");
    await expect(
      failure(page).getByRole("heading", { name: "The zip is larger than the server accepts" }),
    ).toBeVisible();

    await uploadFixture(page, "unknown-token.zip");
    await expect(
      failure(page).getByRole("heading", {
        name: "The target token in manifest.yaml is not known",
      }),
    ).toBeVisible();

    await uploadFixture(page, "mismatch.zip");
    await expect(
      failure(page).getByRole("heading", { name: "This bundle belongs to a different target" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "No versions yet" })).toBeVisible();
  });

  test("maps a server-side size fault on every upload", async ({ page, request }) => {
    await request.post(`${apiOrigin()}/__mock/faults`, { data: { upload_413: true } });
    await openIntake(page, BILLING);

    await uploadFixture(page, "valid.zip");

    await expect(failure(page)).toContainText("The zip is larger than the server accepts");
  });

  test("rejects a file that is not a zip before sending anything", async ({ page }) => {
    const posts: Request[] = [];
    page.on("request", (request) => {
      if (isBundlePost(request)) {
        posts.push(request);
      }
    });
    await openIntake(page, BILLING);

    await page.getByLabel("Bundle zip").setInputFiles(fixture("not-a-zip.txt"));

    await expect(page.getByRole("alert").filter({ hasText: "not-a-zip.txt" })).toContainText(
      "is not a .zip file",
    );
    await expect(page.getByRole("group", { name: "File ready to upload" })).toHaveCount(0);
    expect(posts).toHaveLength(0);
  });

  test("rejects a zip over the size the server reports before sending anything", async ({
    page,
    request,
  }) => {
    await request.post(`${apiOrigin()}/__mock/stage1/limits`, {
      data: { bundle_max_zip_bytes: 10 },
    });
    const posts: Request[] = [];
    page.on("request", (candidate) => {
      if (isBundlePost(candidate)) {
        posts.push(candidate);
      }
    });
    await openIntake(page, BILLING);
    await expect(page.getByText("A .zip of the tessa folder, at most 10 B.")).toBeVisible();

    await page.getByLabel("Bundle zip").setInputFiles(fixture("valid.zip"));

    await expect(page.getByRole("alert").filter({ hasText: "valid.zip" })).toContainText(
      "valid.zip is 22 B; the server accepts at most 10 B.",
    );
    expect(posts).toHaveLength(0);
  });

  test("shows the drag state while a file is dragged over the zone", async ({ page }) => {
    await openIntake(page, BILLING);
    const zone = page.locator("[data-slot='file-drop-zone']");
    await expect(zone).toHaveAttribute("data-dragging", "false");

    await zone.dispatchEvent("dragenter", {
      dataTransfer: await page.evaluateHandle(() => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(["x"], "tessa.zip", { type: "application/zip" }));
        return transfer;
      }),
    });

    await expect(zone).toHaveAttribute("data-dragging", "true");
    await expect(zone).toContainText("Release to choose this file");
    await zone.dispatchEvent("dragleave");
    await expect(zone).toHaveAttribute("data-dragging", "false");
  });

  test("accepts a file dropped on the zone", async ({ page }) => {
    await openIntake(page, BILLING);
    const zone = page.locator("[data-slot='file-drop-zone']");
    const transfer = await page.evaluateHandle(() => {
      const created = new DataTransfer();
      created.items.add(new File([new Uint8Array(22)], "dropped.zip", { type: "application/zip" }));
      return created;
    });

    await zone.dispatchEvent("dragenter", { dataTransfer: transfer });
    await zone.dispatchEvent("drop", { dataTransfer: transfer });

    await expect(page.getByRole("group", { name: "File ready to upload" })).toContainText(
      "dropped.zip",
    );
    await expect(zone).toHaveAttribute("data-dragging", "false");
  });

  test("is operable by keyboard alone, from choosing the file to reading the result", async ({
    page,
  }) => {
    await openIntake(page, BILLING);
    const input = page.getByLabel("Bundle zip");

    await tabTo(page, input);
    await expect(input).toBeFocused();
    const chooser = page.waitForEvent("filechooser");
    await page.keyboard.press("Enter");
    await (await chooser).setFiles(fixture("below-bar.zip"));
    await expect(page.getByRole("group", { name: "File ready to upload" })).toContainText(
      "below-bar.zip",
    );

    const submit = page.getByRole("button", { name: "Upload and validate" });
    await tabTo(page, submit);
    await page.keyboard.press("Enter");

    await expect(result(page).getByRole("heading", { name: "Version 1 created" })).toBeVisible();
    await tabTo(page, result(page).getByRole("link", { name: "Open version 1" }));
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 2, name: "Version 1" })).toBeVisible();
  });

  test("pastes a manifest in the dialog and shows the result on the page", async ({ page }) => {
    await openIntake(page, BILLING);

    await page.getByRole("button", { name: "Paste manifest instead" }).click();
    const dialog = page.getByRole("dialog", { name: "Paste manifest.yaml" });
    await expect(dialog.getByRole("button", { name: "Add version" })).toBeDisabled();
    await dialog.getByLabel("manifest.yaml").fill("# mock: below-bar\nschema: x\n");
    await expect(dialog).toContainText(/\d+ B of [\d.]+ (KiB|MiB)/);
    await dialog.getByLabel("Note (optional)").fill("pasted by hand");
    await dialog.getByRole("button", { name: "Add version" }).click();

    await expect(dialog).toHaveCount(0);
    await expect(result(page).getByRole("heading", { name: "Version 1 created" })).toBeVisible();
    await expect(result(page)).toContainText("Below bar");
    await expect(
      page.getByRole("table", { name: "Bundle versions" }).getByText("Pasted manifest"),
    ).toBeVisible();
  });

  test("keeps the paste dialog open with its text when the manifest carries a secret", async ({
    page,
  }) => {
    await openIntake(page, BILLING);
    await page.getByRole("button", { name: "Paste manifest instead" }).click();
    const dialog = page.getByRole("dialog", { name: "Paste manifest.yaml" });

    await dialog.getByLabel("manifest.yaml").fill("# mock: secret\nschema: x\n");
    await dialog.getByRole("button", { name: "Add version" }).click();

    await expect(
      dialog.getByRole("heading", { name: "The bundle contains what look like secrets" }),
    ).toBeVisible();
    await expect(dialog.getByLabel("manifest.yaml")).toHaveValue("# mock: secret\nschema: x\n");
    await expect(dialog.getByRole("button", { name: "Add version" })).toBeEnabled();
  });

  test("is read-only for a viewer but still lists the versions", async ({ page }) => {
    await page.route(`${apiOrigin()}/api/v1/users/me`, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, role: "viewer" } });
    });

    await page.goto(intakeUrl(GRACIE));

    await expect(page.getByText(/You have read-only access/)).toBeVisible();
    await expect(page.getByLabel("Bundle zip")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Paste manifest instead" })).toHaveCount(0);
    await expect(page.getByRole("table", { name: "Bundle versions" })).toBeVisible();
  });
});

test.describe("bundle detail", () => {
  test.beforeEach(async ({ request }) => {
    await resetMockApi(request);
  });

  test("valid version that meets the bar with warnings", async ({ page }) => {
    await openVersion(page, GRACIE, 2);

    const header = page.getByRole("region", { name: "Version 2" });
    await expect(header).toContainText("Valid");
    await expect(header).toContainText("Meets bar");
    await expect(header).toContainText("Against version 1");
    await expect(page.getByRole("meter", { name: "Completeness score" })).toHaveAttribute(
      "aria-valuenow",
      "92",
    );
    await expect(page.getByText("Bar 80")).toBeVisible();
    const oracle = page.locator("[data-check='oracle_read_only']");
    await expect(oracle).toContainText("10");
    await expect(oracle).toContainText("Partial credit");
    await expect(oracle).toContainText("How to fix");
    await expect(page.getByRole("heading", { level: 2, name: "Validation" })).toBeVisible();
    await expect(page.getByText("Non-text entry ignored")).toBeVisible();
    await expect(page.getByRole("region", { name: "Missing test hooks" })).toContainText(
      "pin_clock",
    );
    await expect(page.getByRole("link", { name: "View the catalog" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Generate Fix-up prompt" })).toHaveAttribute(
      "data-variant",
      "outline",
    );
  });

  test("shows the short commit with the full one on hover, and the branch", async ({ page }) => {
    await openVersion(page, GRACIE, 2);

    const header = page.getByRole("region", { name: "Version 2" });
    const commit = header.getByLabel(`Commit ${GRACIE_SEEDED_COMMIT_SHA}`);
    await expect(commit).toHaveText("9f3c2a1");
    await expect(header.getByText(GRACIE_SEEDED_BRANCH)).toBeVisible();
    await expect(header.getByText("No source recorded")).toHaveCount(0);

    await commit.hover();

    await expect(page.getByRole("tooltip")).toHaveText(GRACIE_SEEDED_COMMIT_SHA);
  });

  test("says no source was recorded when the version has neither commit nor branch", async ({
    page,
  }) => {
    await openVersion(page, GRACIE, 1);

    const header = page.getByRole("region", { name: "Version 1" });
    await expect(header.getByText("No source recorded")).toBeVisible();
    await expect(header.getByLabel(/^Commit /)).toHaveCount(0);
  });

  test("shows the diff against the previous version and lets the base be changed", async ({
    page,
  }) => {
    await openVersion(page, GRACIE, 2);

    const changes = page.getByRole("region", { name: "Changes" });
    await expect(changes).toContainText("Compared with version 1");
    await expect(changes.getByRole("list", { name: "Feature changes" })).toBeVisible();
    await expect(changes.locator("[data-change='added']").first()).toBeVisible();
    await expect(changes.locator("[data-change='changed']").first()).toBeVisible();
    await expect(changes.getByRole("list", { name: "Section changes" })).toBeVisible();

    await page.goto(intakeUrl(GRACIE));
    await page.getByRole("link", { name: "Version 1", exact: true }).click();
    const first = page.getByRole("region", { name: "Changes" });
    await expect(first).toContainText("There is no earlier valid version to compare with.");
    await first.getByRole("combobox", { name: "Compare with" }).click();
    await page.getByRole("option", { name: "Version 2" }).click();
    await expect(first).toContainText("Compared with version 2");
    await expect(first.getByRole("list", { name: "Feature changes" })).toBeVisible();
  });

  test("below-bar version makes the Fix-up prompt primary and opens a copy box", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openVersion(page, GRACIE, 1);
    const generate = page.getByRole("button", { name: "Generate Fix-up prompt" });
    await expect(generate).toHaveAttribute("data-variant", "default");
    await expect(page.getByText("First version, nothing to compare with")).toBeVisible();

    await generate.click();

    const dialog = page.getByRole("dialog", { name: "Fix-up prompt for version 1" });
    const text = dialog.getByRole("textbox", { name: "Fix-up prompt text" });
    await expect(text).toHaveValue(/completeness check feature_examples/);
    await expect(dialog).toContainText(/Template fixup version \d+/);
    await dialog.getByRole("button", { name: "Copy Fix-up prompt" }).click();
    await expect(dialog.getByText("Copied", { exact: true })).toBeVisible();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard.replace(/\r\n/g, "\n")).toBe(await text.inputValue());
    await dialog.getByRole("button", { name: "Close" }).first().click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Show Fix-up prompt" })).toBeVisible();
  });

  test("invalid version shows the errors first and offers no catalog", async ({ page }) => {
    await openVersion(page, BROKEN_IMPORT, 1);

    const headings = await page.getByRole("heading", { level: 2 }).allTextContents();
    expect(headings.slice(0, 3)).toEqual(["Version 1", "Validation errors", "Completeness"]);
    await expect(page.getByRole("region", { name: "Problems in manifest.yaml" })).toContainText(
      "/features/3/kind",
    );
    await expect(page.getByRole("region", { name: "Problems in manifest.yaml" })).toContainText(
      "line 71, column 11",
    );
    await expect(page.getByRole("link", { name: "View the catalog" })).toHaveCount(0);
    await expect(
      page.getByText("No catalog was built from this version because it is invalid."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Generate Fix-up prompt" })).toHaveAttribute(
      "data-variant",
      "default",
    );
  });

  test("previews stored files and marks a truncated one", async ({ page }) => {
    await openVersion(page, GRACIE, 2);
    const files = page.getByRole("region", { name: "Files" });
    await expect(files.getByRole("heading", { level: 3, name: "manifest.yaml" })).toBeVisible();
    await expect(files.locator("pre")).toContainText("schema:");

    await files.getByRole("button", { name: "Preview seeds/reset.sql" }).click();
    await expect(files.locator("pre")).toContainText("TRUNCATE guest_requests");

    await files.getByRole("button", { name: "Preview openapi.json" }).click();
    await expect(files.getByRole("note")).toContainText("This preview is truncated.");
  });

  test("is read-only for a viewer", async ({ page }) => {
    await page.route(`${apiOrigin()}/api/v1/users/me`, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, role: "viewer" } });
    });

    await openVersion(page, GRACIE, 1);

    await expect(page.getByRole("button", { name: "Generate Fix-up prompt" })).toBeDisabled();
    await expect(
      page.getByText("Viewers can read bundles but cannot generate prompts."),
    ).toBeVisible();
  });

  test("shows not found for an unknown bundle", async ({ page }) => {
    await page.goto(`/targets/${GRACIE}/bundles/0198f6f2-4c2a-7d10-9c1e-000000000000`);

    await expect(page.getByRole("heading", { name: "Bundle not found" })).toBeVisible();
    await expect(page.getByRole("link", { name: "All versions" })).toBeVisible();
  });
});

const colorSchemes = ["light", "dark"] as const;

for (const scheme of colorSchemes) {
  test.describe(`axe on the bundle routes in ${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test.beforeEach(async ({ request }) => {
      await resetMockApi(request);
    });

    test.afterEach(async ({ request }) => {
      await clearMockFaults(request);
    });

    test("intake idle, with a staged file and with a result", async ({ page }) => {
      await openIntake(page, GRACIE);
      await expect(page.getByRole("table", { name: "Bundle versions" })).toBeVisible();
      await expectNoAxeViolations(page);

      await chooseFixture(page, "valid.zip");
      await expectNoAxeViolations(page);

      await page.getByRole("button", { name: "Upload and validate" }).click();
      await expect(result(page)).toBeVisible();
      await expectNoAxeViolations(page);
    });

    test("intake with the empty list and with a secret failure", async ({ page }) => {
      await openIntake(page, BILLING);
      await expect(page.getByRole("heading", { name: "No versions yet" })).toBeVisible();
      await expectNoAxeViolations(page);

      await uploadFixture(page, "secret.zip");
      await expect(failure(page)).toBeVisible();
      await expectNoAxeViolations(page);
    });

    test("intake with a rejected file and with the paste dialog", async ({ page }) => {
      await openIntake(page, BILLING);
      await page.getByLabel("Bundle zip").setInputFiles(fixture("not-a-zip.txt"));
      await expect(page.getByRole("alert").filter({ hasText: "not-a-zip.txt" })).toBeVisible();
      await expectNoAxeViolations(page);

      await page.getByRole("button", { name: "Paste manifest instead" }).click();
      const dialog = page.getByRole("dialog", { name: "Paste manifest.yaml" });
      await dialog.getByLabel("manifest.yaml").fill("# mock: secret\n");
      await dialog.getByRole("button", { name: "Add version" }).click();
      await expect(dialog.getByRole("alert", { name: "Upload failed" })).toBeVisible();
      await expectNoAxeViolations(page);
    });

    test("detail of a valid version and of a below-bar version with the Fix-up dialog", async ({
      page,
    }) => {
      await openVersion(page, GRACIE, 2);
      await expect(page.getByRole("list", { name: "Feature changes" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Files" }).locator("pre")).toContainText(
        "schema:",
      );
      await expectNoAxeViolations(page);

      await openVersion(page, GRACIE, 1);
      await expect(page.getByRole("region", { name: "Files" }).locator("pre")).toContainText(
        "schema:",
      );
      await expectNoAxeViolations(page);

      await page.getByRole("button", { name: "Generate Fix-up prompt" }).click();
      await expect(page.getByRole("dialog", { name: "Fix-up prompt for version 1" })).toBeVisible();
      await expectNoAxeViolations(page);
    });

    test("detail of an invalid version", async ({ page }) => {
      await openVersion(page, BROKEN_IMPORT, 1);
      await expect(page.getByRole("region", { name: "Files" }).locator("pre")).toBeVisible();

      await expectNoAxeViolations(page);
    });

    test("detail of a bundle that does not exist", async ({ page }) => {
      await page.goto(`/targets/${GRACIE}/bundles/0198f6f2-4c2a-7d10-9c1e-000000000000`);
      await expect(page.getByRole("heading", { name: "Bundle not found" })).toBeVisible();

      await expectNoAxeViolations(page);
    });
  });
}
