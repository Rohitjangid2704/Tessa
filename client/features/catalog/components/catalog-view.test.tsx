import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberTarget } from "@/features/targets/current-target";
import { buildCatalogItem, groupByArea } from "@/mocks/factories/catalog";
import { MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import { STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { signInAs } from "@/tests/utils/api-session";
import { brokenImportBundle, gracieVersion } from "@/tests/utils/bundles";
import { resetLocation, trackHistory } from "@/tests/utils/fake-navigation";
import { renderWithProviders, screen, userEvent, waitFor, within } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import type { CatalogSelection } from "../selection";
import { CatalogExplorer, CatalogView } from "./catalog-view";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

vi.mock("next/navigation", async () => ({
  ...(await import("@/tests/utils/fake-navigation")),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const { gracie, billing, brokenImport } = STAGE_ONE_IDS;
const UNKNOWN_TARGET = "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b9999";

let history: ReturnType<typeof trackHistory>;

function open(search: string): void {
  resetLocation(`/catalog${search}`);
}

function areaHeadings(): string[] {
  return screen
    .getAllByRole("heading", { level: 2 })
    .map((heading) => heading.textContent ?? "")
    .filter((text) => / features?$/.test(text));
}

function status(): HTMLElement {
  return screen.getByText(/ features? in \d+ areas?$/);
}

async function loaded(): Promise<void> {
  await screen.findByRole("search", { name: "Filter features" });
}

beforeEach(async () => {
  window.localStorage.clear();
  rememberTarget(null);
  history = trackHistory();
  await signInAs(MEMBER_USER);
});

afterEach(() => {
  history.restore();
});

describe("catalog of a target with a valid bundle", () => {
  beforeEach(() => open(`?target_id=${gracie}`));

  it("shows a loading state first and then the areas with their feature counts", async () => {
    renderWithProviders(<CatalogView />);

    expect(screen.getByText("Loading the catalog")).toBeInTheDocument();
    await loaded();

    expect(areaHeadings()).toEqual([
      "Account & Access 4 features",
      "Guest Requests 3 features",
      "Reports 2 features",
      "Smart Log 3 features",
      "Streaming & Jobs 3 features",
    ]);
    expect(status()).toHaveTextContent("15 features in 5 areas");
    expect(screen.getAllByRole("article")).toHaveLength(15);
  });

  it("summarises the bundle and links to it", async () => {
    renderWithProviders(<CatalogView />);
    await loaded();

    const summary = screen.getByRole("region", { name: "Catalog summary" });
    expect(within(summary).getByText("Bundle version 2")).toBeInTheDocument();
    expect(within(summary).getByText(/15 features, 5 areas, 5 roles, 5 interfaces/)).toBeVisible();
    expect(within(summary).getByRole("link", { name: "View bundle" })).toHaveAttribute(
      "href",
      `/targets/${gracie}/bundles/${gracieVersion(2).bundle.id}`,
    );
  });

  it("lists the roles and interfaces of the bundle on demand", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CatalogView />);
    await loaded();

    await user.click(screen.getByRole("button", { name: "Roles and interfaces" }));

    const summary = screen.getByRole("region", { name: "Catalog summary" });
    expect(within(summary).getByText("front_desk")).toBeVisible();
    expect(within(summary).getByText("chat_sse")).toBeVisible();
    expect(within(summary).getByText("/api/v1/chat")).toBeVisible();
  });

  it("shows every feature card with its kind, interfaces, roles and confidence", async () => {
    renderWithProviders(<CatalogView />);
    await loaded();

    const card = screen.getByRole("article", {
      name: "guest_requests.write.create_service_request",
    });

    expect(within(card).getByText("Write")).toBeInTheDocument();
    expect(within(card).getByText("High confidence")).toBeInTheDocument();
    expect(within(card).getByRole("list", { name: "Interfaces" })).toHaveTextContent("chat_sse");
    expect(within(card).getByRole("list", { name: "Roles" })).toHaveTextContent("front_desk");
    expect(within(card).getByRole("list", { name: "Flag" })).toHaveTextContent(
      "GUEST_REQUESTS_WRITE_ENABLED",
    );
  });

  it("lets a viewer read the catalog", async () => {
    await signInAs(VIEWER_USER);
    renderWithProviders(<CatalogView />);

    await loaded();

    expect(screen.getAllByRole("article")).toHaveLength(15);
  });

  it("offers no selection controls in this phase", async () => {
    renderWithProviders(<CatalogView />);
    await loaded();

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("starts a 500-feature catalog with its areas collapsed and opens them on demand", async () => {
    const items = Array.from({ length: 500 }, (_, index) =>
      buildCatalogItem({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        feature_id: `area_${index % 25}.read.feature_${index}`,
        area: `Area ${String(index % 25).padStart(2, "0")}`,
        interface_ids: ["rest_api"],
        examples: [{ ask: "Ask", expected: "Expect" }],
      }),
    );
    server.use(
      http.get("*/api/v1/catalog", () =>
        HttpResponse.json({
          bundle_id: gracieVersion(2).bundle.id,
          bundle_version: 2,
          roles: [],
          interfaces: [],
          areas: groupByArea(items),
        }),
      ),
    );

    renderWithProviders(<CatalogView />);
    await loaded();

    expect(status()).toHaveTextContent("500 features in 25 areas");
    expect(screen.getByText(/This catalog is large/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Area \d\d / })).toHaveLength(25);
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: /^Area 00 / }));

    expect(screen.getAllByRole("article")).toHaveLength(20);
  }, 30_000);

  it("opens the areas again when a filter brings a large catalog under the limit", async () => {
    const items = Array.from({ length: 300 }, (_, index) =>
      buildCatalogItem({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        feature_id: `area_${index % 3}.read.feature_${index}`,
        area: `Area ${index % 3}`,
        description: `Feature number ${index}`,
      }),
    );
    server.use(
      http.get("*/api/v1/catalog", ({ request }) => {
        const text = new URL(request.url).searchParams.get("q");
        const matching = items.filter((item) => text === null || item.description.includes(text));
        return HttpResponse.json({
          bundle_id: gracieVersion(2).bundle.id,
          bundle_version: 2,
          roles: [],
          interfaces: [],
          areas: groupByArea(matching),
        });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<CatalogView />);
    await loaded();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Search" }), "number 29");

    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(11));
    expect(screen.queryByText(/This catalog is large/)).not.toBeInTheDocument();
  }, 30_000);
});

describe("catalog filters", () => {
  beforeEach(() => open(`?target_id=${gracie}`));

  it("filters by kind from the filter bar and writes it to the URL", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CatalogView />);
    await loaded();

    await user.click(screen.getByRole("button", { name: "Kind: any" }));
    await user.click(await screen.findByRole("checkbox", { name: "Write" }));

    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    expect(window.location.search).toBe(`?target_id=${gracie}&kind=write`);
    expect(status()).toHaveTextContent("Showing 2 of 15 features in 2 areas");
    expect(areaHeadings()).toEqual(["Guest Requests 1 of 3 features", "Smart Log 1 of 3 features"]);
  });

  it("filters by area, role, interface and confidence", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CatalogView />);
    await loaded();

    await user.click(screen.getByRole("button", { name: "Area: any" }));
    await user.click(await screen.findByRole("checkbox", { name: "Reports" }));
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Confidence: any" }));
    await user.click(await screen.findByRole("checkbox", { name: "High" }));
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
    expect(
      screen.getByRole("article", { name: "reports.read.occupancy_summary" }),
    ).toBeInTheDocument();
    expect(window.location.search).toContain("area=Reports");
    expect(window.location.search).toContain("confidence=high");
  });

  it("searches by text and writes the search to the URL", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CatalogView />);
    await loaded();

    await user.type(screen.getByRole("searchbox", { name: "Search" }), "escalat");

    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
    expect(window.location.search).toBe(`?target_id=${gracie}&q=escalat`);
    expect(screen.getByRole("article", { name: "streaming.job.escalation_sweep" })).toBeVisible();
  });

  it("restores every filter from the URL on load", async () => {
    open(`?target_id=${gracie}&role=guest&interface_id=browser&kind=flow&kind=read`);
    renderWithProviders(<CatalogView />);

    await loaded();
    await waitFor(() => expect(status()).toHaveTextContent(/^Showing \d+ of 15 features/));

    expect(screen.getByRole("button", { name: "Kind: 2 selected" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Role: 1 selected" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Interface: 1 selected" })).toBeInTheDocument();
    const ids = screen
      .getAllByRole("article")
      .map((card) => card.querySelector("h3")?.textContent)
      .sort();
    expect(ids).toEqual([
      "guest_requests.flow.request_and_track",
      "smart_log.read.open_maintenance",
    ]);
  });

  it("explains a search with no match and recovers on clear", async () => {
    const user = userEvent.setup();
    open(`?target_id=${gracie}&q=zzzz`);
    renderWithProviders(<CatalogView />);

    expect(await screen.findByRole("heading", { name: "No features match" })).toBeInTheDocument();
    expect(status()).toHaveTextContent("Showing 0 of 15 features in 0 areas");
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Clear filters" })[0] as HTMLElement);

    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(15));
    expect(window.location.search).toBe(`?target_id=${gracie}`);
  });

  it("keeps the area options of the whole bundle while a filter narrows the list", async () => {
    const user = userEvent.setup();
    open(`?target_id=${gracie}&kind=write`);
    renderWithProviders(<CatalogView />);
    await loaded();
    await waitFor(() => expect(status()).toHaveTextContent("Showing 2 of 15"));

    await user.click(screen.getByRole("button", { name: "Area: any" }));

    expect(await screen.findByRole("checkbox", { name: "Reports" })).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(5);
  });
});

describe("catalog without a catalog to show", () => {
  it("sends a target without any bundle to the intake page", async () => {
    open(`?target_id=${billing}`);
    renderWithProviders(<CatalogView />);

    expect(await screen.findByRole("heading", { name: "No valid bundle yet" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Upload a bundle" })).toHaveAttribute(
      "href",
      `/targets/${billing}/bundles`,
    );
    expect(screen.queryByRole("search")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("links to the errors when the latest bundle is invalid", async () => {
    open(`?target_id=${brokenImport}`);
    renderWithProviders(<CatalogView />);

    expect(await screen.findByRole("heading", { name: "No valid bundle yet" })).toBeInTheDocument();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Version 1 did not validate")).toBeInTheDocument();
    expect(
      within(alert).getByRole("link", { name: "See the validation errors for version 1" }),
    ).toHaveAttribute("href", `/targets/${brokenImport}/bundles/${brokenImportBundle().bundle.id}`);
    expect(screen.getByRole("link", { name: "Upload a bundle" })).toHaveAttribute(
      "href",
      `/targets/${brokenImport}/bundles`,
    );
  });

  it("handles an explicit invalid bundle id with the same empty shape", async () => {
    const invalidId = brokenImportBundle().bundle.id;
    open(`?target_id=${brokenImport}&bundle_id=${invalidId}`);
    renderWithProviders(<CatalogView />);

    expect(
      await screen.findByRole("heading", { name: "This bundle has no catalog" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Version 1 did not validate")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "See the validation errors for version 1" }),
    ).toHaveAttribute("href", `/targets/${brokenImport}/bundles/${invalidId}`);
  });

  it("ignores a bundle_id that is not an id", async () => {
    open(`?target_id=${gracie}&bundle_id=not-an-id`);
    renderWithProviders(<CatalogView />);

    await loaded();

    expect(screen.getAllByRole("article")).toHaveLength(15);
  });

  it("asks for a target when none is selected", async () => {
    open("");
    renderWithProviders(<CatalogView />);

    expect(await screen.findByRole("heading", { name: "Choose a target" })).toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: "Choose a target" })).toBeInTheDocument();
    expect(screen.queryByRole("search")).not.toBeInTheDocument();
  });

  it("falls back to the last used target", async () => {
    open("");
    rememberTarget(gracie);
    renderWithProviders(<CatalogView />);

    await loaded();

    expect(screen.getAllByRole("article")).toHaveLength(15);
  });
});

describe("catalog errors", () => {
  beforeEach(() => open(`?target_id=${gracie}`));

  it("shows the request id and recovers on retry", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(
        "*/api/v1/catalog",
        () =>
          HttpResponse.json(
            {
              error: {
                code: "internal_error",
                message: "Something broke",
                request_id: "req-catalog-500",
                details: [],
              },
            },
            { status: 500 },
          ),
        { once: true },
      ),
    );
    renderWithProviders(<CatalogView />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the catalog");
    expect(screen.getByText("Request ID: req-catalog-500")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    await loaded();
    expect(screen.getAllByRole("article")).toHaveLength(15);
  });

  it("says when the target does not exist and offers no retry", async () => {
    open(`?target_id=${UNKNOWN_TARGET}`);
    renderWithProviders(<CatalogView />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Target or bundle not found");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to targets" })).toHaveAttribute(
      "href",
      "/targets",
    );
  });
});

describe("catalog ready for selection", () => {
  beforeEach(() => open(`?target_id=${gracie}`));

  it("shows area and feature checkboxes once selection state is passed in", async () => {
    const chosen = new Set<string>();
    const selection: CatalogSelection = {
      isSelected: (itemId) => chosen.has(itemId),
      onToggleItem: (item, selected) => {
        if (selected) {
          chosen.add(item.id);
        } else {
          chosen.delete(item.id);
        }
      },
      onToggleArea: vi.fn(),
    };
    const user = userEvent.setup();
    renderWithProviders(<CatalogExplorer targetId={gracie} selection={selection} />);
    await loaded();

    expect(screen.getAllByRole("checkbox", { name: /^Select every feature in / })).toHaveLength(5);
    await user.click(
      screen.getByRole("checkbox", { name: "Select reports.read.occupancy_summary" }),
    );

    expect(chosen.size).toBe(1);
  });
});
