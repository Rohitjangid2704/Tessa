import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  buildSeededExplanations,
  explanationVariantOf,
  type ExplanationVariant,
} from "../../../mocks/stage5/explanation-seed";
import { findingIdOf, SEEDED_FINDING_COUNT } from "../../../mocks/stage5/findings-seed";
import { apiOrigin } from "../helpers/env";
import { clearMockFaults, resetMockApi } from "../helpers/mock-api";

const LONG_FILE_LIST_MIN = 10;

function findingWith(variant: ExplanationVariant, accept: (id: string) => boolean = () => true) {
  for (let index = 0; index < SEEDED_FINDING_COUNT; index += 1) {
    const id = findingIdOf(index);
    if (explanationVariantOf(id) === variant && accept(id)) {
      return id;
    }
  }
  throw new Error(`no seeded finding with the ${variant} explanation variant`);
}

function hasLongFileList(id: string): boolean {
  return buildSeededExplanations({ id, last_seen_at: "2026-10-03T09:30:00.000Z" }, true).some(
    (explanation) => (explanation.structured?.files?.length ?? 0) >= LONG_FILE_LIST_MIN,
  );
}

async function showStructuredExplanations(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${apiOrigin()}/__mock/stage11/seed`, {
    data: { variants: { explanations: "structured" } },
  });
  expect(response.ok()).toBe(true);
}

test.beforeEach(async ({ request }) => {
  await resetMockApi(request);
});

test.afterEach(async ({ request }) => {
  await clearMockFaults(request);
});

test.describe("structured explanations", () => {
  test("shows the card above the text and the opinion chip in the header", async ({
    page,
    request,
  }) => {
    await showStructuredExplanations(request);
    const id = findingWith("structured");

    await page.goto(`/findings/${id}?tab=explanations`);

    const card = page.locator("[data-slot=structured-explanation]");
    await expect(card).toBeVisible();
    await expect(card.getByRole("heading", { name: "Root cause" })).toBeVisible();
    await expect(card.getByRole("list", { name: "Files" })).toBeVisible();
    await expect(card.getByText(/ confidence$/)).toBeVisible();
    const item = page.locator("[data-slot=explanation-item]").first();
    const cardBox = await card.boundingBox();
    const textBox = await item.locator("p").last().boundingBox();
    expect(cardBox?.y ?? 0).toBeLessThan(textBox?.y ?? 0);
    const opinion = await card.getAttribute("data-opinion");
    await expect(
      page.locator("[data-slot=finding-detail] header [data-slot=explanation-opinion]"),
    ).toHaveAttribute("data-opinion", opinion ?? "");
  });

  test("shows a plain explanation without a card or a header chip", async ({ page, request }) => {
    await showStructuredExplanations(request);
    const id = findingWith("text");

    await page.goto(`/findings/${id}?tab=explanations`);

    await expect(page.locator("[data-slot=explanation-item]")).toHaveCount(1);
    await expect(page.locator("[data-slot=structured-explanation]")).toHaveCount(0);
    await expect(page.locator("[data-slot=explanation-opinion]")).toHaveCount(0);
  });

  test("keeps the plain text and the card of a finding that has both", async ({
    page,
    request,
  }) => {
    await showStructuredExplanations(request);
    const id = findingWith("both");

    await page.goto(`/findings/${id}?tab=explanations`);

    await expect(page.locator("[data-slot=explanation-item]")).toHaveCount(2);
    await expect(page.locator("[data-slot=structured-explanation]")).toHaveCount(1);
  });

  test("scrolls a long file list inside the card", async ({ page, request }) => {
    await showStructuredExplanations(request);
    const id = findingWith("structured", hasLongFileList);

    await page.goto(`/findings/${id}?tab=explanations`);

    const files = page.locator("[data-slot=structured-explanation]").getByRole("list", {
      name: "Files",
    });
    await expect(files.getByRole("listitem")).not.toHaveCount(0);
    const scrolls = await files.evaluate((element) => element.scrollHeight > element.clientHeight);
    expect(scrolls).toBe(true);
  });

  test("shows no card anywhere with the plain-text seed", async ({ page }) => {
    await page.goto(`/findings/${findingWith("structured")}?tab=explanations`);

    await expect(page.locator("[data-slot=explanation-item]")).toHaveCount(1);
    await expect(page.locator("[data-slot=structured-explanation]")).toHaveCount(0);
  });
});
