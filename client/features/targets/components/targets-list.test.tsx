import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockState } from "@/mocks/handlers";
import { MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import { signInAs } from "@/tests/utils/api-session";
import { resetLocation, trackHistory } from "@/tests/utils/fake-navigation";
import { renderWithProviders, screen, userEvent, waitFor, within } from "@/tests/utils/render";
import { TargetsList } from "./targets-list";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

vi.mock("next/navigation", async () => await import("@/tests/utils/fake-navigation"));

let history: ReturnType<typeof trackHistory>;

function table() {
  return screen.getByRole("table", { name: "Targets" });
}

function rowOf(name: string) {
  return within(table()).getByRole("row", { name: new RegExp(`^${name}`) });
}

function names(): string[] {
  return within(table())
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0]?.querySelector("a")?.textContent ?? "");
}

async function loaded(): Promise<void> {
  await screen.findByText(/^Showing [0-9]+ of [0-9]+ targets?$/);
}

beforeEach(async () => {
  resetLocation("/targets");
  history = trackHistory();
  await signInAs(MEMBER_USER);
});

afterEach(() => {
  history.restore();
});

describe("TargetsList columns", () => {
  it("shows skeleton rows while loading and then every column of every active target", async () => {
    renderWithProviders(<TargetsList />);

    expect(screen.getByText("Loading targets")).toBeInTheDocument();
    await loaded();

    expect(
      within(table())
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Name", "App kind", "Tier", "Latest bundle", "Completeness", "Health", "Created"]);
    expect(names()).toEqual(["Broken Import", "Live Shop", "Billing API", "Gracie"]);
    expect(screen.getByText("Showing 4 of 4 targets")).toBeInTheDocument();
  });

  it("links the name to the target page", async () => {
    renderWithProviders(<TargetsList />);
    await loaded();

    const link = within(rowOf("Gracie")).getByRole("link", { name: "Gracie" });

    expect(link).toHaveAttribute("href", expect.stringMatching(/^\/targets\/[0-9a-f-]{36}$/));
  });

  it("shows the latest bundle, completeness and health of a target with bundles", async () => {
    renderWithProviders(<TargetsList />);
    await loaded();
    const row = rowOf("Gracie");

    expect(within(row).getByText("LLM assistant")).toBeInTheDocument();
    expect(within(row).getByText("QA")).toBeInTheDocument();
    expect(within(row).getByText("v2")).toBeInTheDocument();
    expect(within(row).getByText("92 / 100")).toBeInTheDocument();
    expect(within(row).getByText("Failed")).toBeInTheDocument();
  });

  it("shows None and Unchecked for a target without a bundle", async () => {
    renderWithProviders(<TargetsList />);
    await loaded();
    const row = rowOf("Billing API");

    expect(within(row).getAllByText("None")).toHaveLength(2);
    expect(within(row).getByText("Unchecked")).toBeInTheDocument();
    expect(within(row).getByText("HTTP API")).toBeInTheDocument();
  });

  it("makes a production target loud", async () => {
    renderWithProviders(<TargetsList />);
    await loaded();

    const badge = within(rowOf("Live Shop")).getByText("Production");

    expect(badge.closest("[data-slot=status-badge]")).toHaveAttribute(
      "data-tone",
      "severity-critical-solid",
    );
  });

  it("gives the created time a machine readable value and a UTC tooltip", async () => {
    renderWithProviders(<TargetsList />);
    await loaded();

    const time = rowOf("Gracie").querySelector("time");

    expect(time).toHaveAttribute("datetime", "2026-09-10T08:00:00.000Z");
    expect(time).toHaveAttribute("title", "2026-09-10 08:00:00 UTC");
  });
});

describe("TargetsList sorting and filters", () => {
  it("sorts newest first by default and sorts by name through the URL", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TargetsList />);
    await loaded();
    expect(screen.getByRole("columnheader", { name: /Created/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );

    await user.click(screen.getByRole("button", { name: "Sort by Name" }));

    await waitFor(() =>
      expect(names()).toEqual(["Billing API", "Broken Import", "Gracie", "Live Shop"]),
    );
    expect(window.location.search).toBe("?sort=name");
    expect(history.calls.push).toEqual([]);
  });

  it("does not offer sorting on the other columns", async () => {
    renderWithProviders(<TargetsList />);
    await loaded();

    expect(screen.queryByRole("button", { name: "Sort by Tier" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sort by App kind" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sort by Health" })).not.toBeInTheDocument();
  });

  it("filters by search text and writes it to the URL", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TargetsList />);
    await loaded();

    await user.type(screen.getByRole("searchbox", { name: "Search" }), "grac");

    await waitFor(() => expect(names()).toEqual(["Gracie"]));
    expect(window.location.search).toBe("?q=grac");
  });

  it("restores app kind, tier and archived filters from the URL", async () => {
    resetLocation("/targets?app_kind=web&app_kind=cli&include_archived=true");
    renderWithProviders(<TargetsList />);

    await loaded();

    expect(names()).toEqual(["Live Shop", "Legacy Portal"]);
    expect(screen.getByRole("button", { name: "App kind: 2 selected" })).toBeInTheDocument();
    expect(within(rowOf("Legacy Portal")).getByText("Archived")).toBeInTheDocument();
    expect(rowOf("Legacy Portal")).toHaveAttribute("data-archived", "true");
    expect(screen.getByRole("switch", { name: "Include archived" })).toBeChecked();
  });

  it("filters by tier from the filter bar", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TargetsList />);
    await loaded();

    await user.click(screen.getByRole("button", { name: "Tier: any" }));
    await user.click(await screen.findByRole("checkbox", { name: "Production" }));

    await waitFor(() => expect(names()).toEqual(["Live Shop"]));
    expect(window.location.search).toBe("?tier=production");
  });

  it("hides archived targets until asked for and shows them when included", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TargetsList />);
    await loaded();
    expect(names()).not.toContain("Legacy Portal");

    await user.click(screen.getByRole("switch", { name: "Include archived" }));

    await waitFor(() => expect(names()).toContain("Legacy Portal"));
    expect(window.location.search).toBe("?include_archived=true");
  });

  it("explains a filter with no match and recovers on clear", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TargetsList />);
    await loaded();

    await user.type(screen.getByRole("searchbox", { name: "Search" }), "zzz");

    expect(await screen.findByRole("heading", { name: "No targets match" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));

    await loaded();
    expect(window.location.search).toBe("");
  });
});

describe("TargetsList without targets", () => {
  beforeEach(() => {
    mockState.stageOne.reset("empty");
  });

  it("offers New target to a member", async () => {
    renderWithProviders(<TargetsList />);

    expect(await screen.findByRole("heading", { name: "No targets yet" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "New target" })).toHaveAttribute(
      "href",
      "/targets/new",
    );
  });

  it("shows a viewer the empty state without a New target link", async () => {
    await signInAs(VIEWER_USER);
    renderWithProviders(<TargetsList />);

    expect(await screen.findByRole("heading", { name: "No targets yet" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "New target" })).not.toBeInTheDocument();
  });
});
