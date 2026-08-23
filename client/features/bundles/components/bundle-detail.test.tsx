import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildBundle } from "@/mocks/factories/bundles";
import { MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import { signInAs } from "@/tests/utils/api-session";
import {
  BILLING_ID,
  BROKEN_IMPORT_ID,
  brokenImportBundle,
  GRACIE_ID,
  gracieVersion,
} from "@/tests/utils/bundles";
import { server } from "@/tests/utils/server";
import { renderWithProviders, screen, userEvent, waitFor, within } from "@/tests/utils/render";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const { BundleDetail } = await import("./bundle-detail");

beforeEach(async () => {
  await signInAs(MEMBER_USER);
});

function errorBody(code: string, message: string) {
  return { error: { code, message, request_id: "req-detail", details: [] } };
}

async function renderDetail(targetId: string, bundleId: string) {
  const view = renderWithProviders(<BundleDetail targetId={targetId} bundleId={bundleId} />);
  await screen.findByRole("heading", { level: 2, name: /^Version \d+$/ });
  return view;
}

function headingsOf(level: number): string[] {
  return screen.getAllByRole("heading", { level }).map((heading) => heading.textContent ?? "");
}

describe("BundleDetail for a valid version that meets the bar with warnings", () => {
  beforeEach(async () => {
    await renderDetail(GRACIE_ID, gracieVersion(2).bundle.id);
  });

  it("shows the version, both badges, the source and the stored diff summary", () => {
    expect(screen.getByRole("heading", { level: 2, name: "Version 2" })).toBeInTheDocument();
    const header = screen.getByRole("region", { name: "Version 2" });
    expect(within(header).getByText("Valid")).toBeInTheDocument();
    expect(within(header).getByText("Meets bar")).toBeInTheDocument();
    expect(within(header).getByText(/Zip upload, uploaded/)).toBeInTheDocument();
    expect(within(header).getByText("Note: Fix-up applied")).toBeInTheDocument();
    const summary = gracieVersion(2).bundle.diff_summary;
    expect(summary).not.toBeNull();
    expect(
      within(header).getByText(
        `Against version 1: ${summary?.features_added} added, ${summary?.features_removed} removed, ${summary?.features_changed} changed`,
      ),
    ).toBeInTheDocument();
  });

  it("shows partial credit per check, with the bar", () => {
    expect(screen.getByRole("meter", { name: "Completeness score" })).toHaveAttribute(
      "aria-valuenow",
      "92",
    );
    const oracle = document.querySelector("[data-check='oracle_read_only']");
    expect(oracle).toHaveAttribute("data-credit", "partial");
    expect(
      within(oracle as HTMLElement).getByText(
        "11 of 15 computable features have a read-only oracle",
      ),
    ).toBeInTheDocument();
  });

  it("lists the warnings and the missing hooks as information", () => {
    expect(screen.getByRole("heading", { level: 2, name: "Validation" })).toBeInTheDocument();
    expect(screen.getByText("Non-text entry ignored")).toBeInTheDocument();
    const hooks = screen.getByRole("region", { name: "Missing test hooks" });
    expect(within(hooks).getByText("pin_clock")).toBeInTheDocument();
    expect(within(hooks).getByText("flush_caches")).toBeInTheDocument();
    expect(within(hooks).queryByText(/Phase 8/)).not.toBeInTheDocument();
    expect(within(hooks).getByText(/Hooks prompt on the Mutation page/)).toBeInTheDocument();
  });

  it("shows the short commit with the full one on hover, and the branch, in the header", async () => {
    const user = userEvent.setup();
    const header = screen.getByRole("region", { name: "Version 2" });

    expect(within(header).getByText("9f3c2a1")).toBeInTheDocument();
    expect(within(header).getByText("qa/tessa-bundle")).toBeInTheDocument();
    expect(within(header).queryByText("No source recorded")).not.toBeInTheDocument();

    await user.hover(within(header).getByText("9f3c2a1"));

    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      gracieVersion(2).bundle.commit_sha as string,
    );
  });

  it("offers the Fix-up prompt as a secondary action and links to the catalog and the versions", () => {
    expect(screen.getByRole("button", { name: "Generate Fix-up prompt" })).toHaveAttribute(
      "data-variant",
      "outline",
    );
    expect(screen.getByRole("link", { name: "View the catalog" })).toHaveAttribute(
      "href",
      `/catalog?target_id=${GRACIE_ID}`,
    );
    expect(screen.getByRole("link", { name: "All versions" })).toHaveAttribute(
      "href",
      `/targets/${GRACIE_ID}/bundles`,
    );
  });

  it("puts completeness before the validation list and ends with the diff and the files", () => {
    expect(headingsOf(2)).toEqual([
      "Version 2",
      "Completeness",
      "Validation",
      "Missing test hooks",
      "Changes",
      "Files",
    ]);
  });
});

describe("BundleDetail for a valid version below the bar", () => {
  beforeEach(async () => {
    await renderDetail(GRACIE_ID, gracieVersion(1).bundle.id);
  });

  it("makes the Fix-up prompt the primary action", () => {
    expect(screen.getByRole("button", { name: "Generate Fix-up prompt" })).toHaveAttribute(
      "data-variant",
      "default",
    );
    expect(
      within(screen.getByRole("region", { name: "Version 1" })).getByText("Below bar"),
    ).toBeInTheDocument();
    expect(screen.getByText("25 points short of the bar of 80.")).toBeInTheDocument();
  });

  it("explains partial earned points and the first version has no diff", async () => {
    const examples = document.querySelector("[data-check='feature_examples']");
    expect(examples).toHaveAttribute("data-credit", "partial");
    expect(within(examples as HTMLElement).getByText(/How to fix/)).toBeInTheDocument();
    expect(screen.getByText("First version, nothing to compare with")).toBeInTheDocument();
    expect(
      await screen.findByText("There is no earlier valid version to compare with."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Missing test hooks" })).not.toBeInTheDocument();
  });

  it("lists both warnings of the version", () => {
    expect(screen.getByText("Non-text entry ignored")).toBeInTheDocument();
    expect(screen.getByText(/names oracle 'user_by_token'/)).toBeInTheDocument();
  });
});

describe("BundleDetail for an invalid version", () => {
  beforeEach(async () => {
    await renderDetail(BROKEN_IMPORT_ID, brokenImportBundle().bundle.id);
  });

  it("shows the errors first, grouped by file, with pointer, line and column", () => {
    expect(headingsOf(2)).toEqual([
      "Version 1",
      "Validation errors",
      "Completeness",
      "Changes",
      "Files",
    ]);
    const manifest = within(screen.getByRole("region", { name: "Problems in manifest.yaml" }));
    expect(manifest.getAllByRole("listitem")).toHaveLength(3);
    expect(manifest.getByText("/features/3/kind")).toBeInTheDocument();
    expect(manifest.getByText("line 71, column 11")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Problems in env.template" })).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Problems in flows/request_and_track.yaml" }),
    ).toBeInTheDocument();
    expect(screen.getByText("5 errors and 0 warnings in 3 files.")).toBeInTheDocument();
  });

  it("offers no catalog link and says why, and the Fix-up prompt is primary", () => {
    expect(screen.queryByRole("link", { name: "View the catalog" })).not.toBeInTheDocument();
    expect(
      screen.getByText("No catalog was built from this version because it is invalid."),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Version 1" })).getByText("Invalid"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate Fix-up prompt" })).toHaveAttribute(
      "data-variant",
      "default",
    );
    expect(screen.getByText(/score is read from the raw manifest/)).toBeInTheDocument();
  });

  it("never shows a success tone for completeness without the status text", () => {
    const checks = Array.from(document.querySelectorAll("[data-check]"));
    expect(checks).toHaveLength(6);
    for (const check of checks) {
      expect(check).toHaveAttribute("data-credit", "none");
      expect(within(check as HTMLElement).getByText("No credit")).toBeInTheDocument();
    }
  });
});

describe("BundleDetail when nothing is open", () => {
  it("shows a neutral line instead of the Fix-up prompt", async () => {
    const perfect = buildBundle({ target_id: GRACIE_ID, version: 7 });
    server.use(http.get("*/api/v1/bundles/:bundle_id", () => HttpResponse.json(perfect)));

    await renderDetail(GRACIE_ID, perfect.id);

    expect(
      screen.getByText(
        "Nothing is open: no errors, no warnings and every check earned full credit.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Fix-up prompt/ })).not.toBeInTheDocument();
    expect(screen.getByText("Every check earned full credit.")).toBeInTheDocument();
  });
});

describe("BundleDetail for a viewer", () => {
  it("reads everything but cannot generate prompts, and says why", async () => {
    await signInAs(VIEWER_USER);
    await renderDetail(GRACIE_ID, gracieVersion(1).bundle.id);

    const button = await screen.findByRole("button", { name: "Generate Fix-up prompt" });
    await waitFor(() => expect(button).toBeDisabled());
    expect(
      screen.getByText("Viewers can read bundles but cannot generate prompts."),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Completeness" })).toBeInTheDocument();
  });
});

describe("BundleDetail loading and errors", () => {
  it("shows a loading state first", () => {
    renderWithProviders(
      <BundleDetail targetId={GRACIE_ID} bundleId={gracieVersion(1).bundle.id} />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Loading the bundle");
  });

  it("shows not found without a retry for an unknown bundle", async () => {
    server.use(
      http.get("*/api/v1/bundles/:bundle_id", () =>
        HttpResponse.json(errorBody("not_found", "Bundle not found"), { status: 404 }),
      ),
    );
    renderWithProviders(
      <BundleDetail targetId={GRACIE_ID} bundleId="0198f6f2-4c2a-7d10-9c1e-000000000000" />,
    );

    expect(await screen.findByRole("heading", { name: "Bundle not found" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All versions" })).toHaveAttribute(
      "href",
      `/targets/${GRACIE_ID}/bundles`,
    );
  });

  it("shows a retry for a server error and recovers", async () => {
    let fail = true;
    server.use(
      http.get("*/api/v1/bundles/:bundle_id", ({ request }) => {
        if (fail) {
          return HttpResponse.json(errorBody("internal_error", "boom"), { status: 500 });
        }
        const id = new URL(request.url).pathname.split("/").pop();
        return HttpResponse.json(buildBundle({ id, target_id: GRACIE_ID, version: 9 }));
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <BundleDetail targetId={GRACIE_ID} bundleId={gracieVersion(1).bundle.id} />,
    );
    expect(
      await screen.findByRole("heading", { name: "Could not load the bundle" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("Request ID: req-detail")).toBeInTheDocument();

    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { level: 2, name: "Version 9" })).toBeInTheDocument();
  });

  it("refuses to show a bundle under the wrong target and links to the right one", async () => {
    const bundle = gracieVersion(2).bundle;
    renderWithProviders(<BundleDetail targetId={BILLING_ID} bundleId={bundle.id} />);

    expect(
      await screen.findByRole("heading", { name: "This version belongs to another target" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open it under its own target" })).toHaveAttribute(
      "href",
      `/targets/${GRACIE_ID}/bundles/${bundle.id}`,
    );
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
  });
});
