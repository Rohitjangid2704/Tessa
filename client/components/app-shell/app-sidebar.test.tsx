import { beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { renderWithProviders, screen, within } from "@/tests/utils/render";
import { AppSidebar } from "./app-sidebar";

const navigation = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));
vi.mock("./user-menu", () => ({ UserMenu: () => <div>user menu</div> }));

function renderSidebar(targetId?: string | null) {
  return renderWithProviders(
    <SidebarProvider>
      <AppSidebar user={{ name: "Admin", email: "admin@tessa.local" }} targetId={targetId} />
    </SidebarProvider>,
  );
}

function mainNavigation() {
  return screen.getByRole("navigation", { name: "Main" });
}

beforeEach(() => {
  navigation.pathname = "/";
});

describe("AppSidebar", () => {
  it("renders the brand link to Home, the eight pages in order and the Truth group", () => {
    renderSidebar();

    expect(screen.getByRole("link", { name: "Tessa home" })).toHaveAttribute("href", "/");
    const links = within(mainNavigation()).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Targets",
      "Catalog",
      "Scenarios",
      "Runs",
      "Findings",
      "Labels",
      "Explore",
      "Seeds",
      "Oracle",
      "Settings",
    ]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/targets",
      "/catalog",
      "/scenarios",
      "/runs",
      "/findings",
      "/labels",
      "/explore",
      "/seeds",
      "/oracle",
      "/settings",
    ]);
  });

  it("puts Seeds and Oracle under a Truth label inside the main navigation", () => {
    renderSidebar();

    const label = within(mainNavigation()).getByText("Truth");
    const group = label.closest("[data-nav-group]");
    expect(group).toHaveAttribute("data-nav-group", "truth");
    expect(
      within(group as HTMLElement)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Seeds", "Oracle"]);
  });

  it("marks Oracle as current on its own page", () => {
    navigation.pathname = "/oracle";
    renderSidebar();

    const current = within(mainNavigation())
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.textContent)).toEqual(["Oracle"]);
  });

  it("marks only Home as current on the root path", () => {
    renderSidebar();

    expect(screen.getByRole("link", { name: "Tessa home" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    for (const link of within(mainNavigation()).getAllByRole("link")) {
      expect(link).not.toHaveAttribute("aria-current");
    }
  });

  it("marks the page whose path contains the current one", () => {
    navigation.pathname = "/runs/0198f6f2-4c2a/steps/3";
    renderSidebar();

    const current = within(mainNavigation())
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.textContent)).toEqual(["Runs"]);
    expect(screen.getByRole("link", { name: "Tessa home" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("does not mark a page for a path it does not own", () => {
    navigation.pathname = "/dev/tokens";
    renderSidebar();

    for (const link of within(mainNavigation()).getAllByRole("link")) {
      expect(link).not.toHaveAttribute("aria-current");
    }
  });

  it("carries target_id on the pages that take a target once one is known", () => {
    renderSidebar("0198f6f2-4c2a");

    const hrefs = Object.fromEntries(
      within(mainNavigation())
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    );
    expect(hrefs).toMatchObject({
      Targets: "/targets",
      Catalog: "/catalog?target_id=0198f6f2-4c2a",
      Scenarios: "/scenarios?target_id=0198f6f2-4c2a",
      Runs: "/runs?target_id=0198f6f2-4c2a",
      Findings: "/findings?target_id=0198f6f2-4c2a",
      Labels: "/labels?target_id=0198f6f2-4c2a",
      Explore: "/explore?target_id=0198f6f2-4c2a",
      Seeds: "/seeds?target_id=0198f6f2-4c2a",
      Oracle: "/oracle?target_id=0198f6f2-4c2a",
      Settings: "/settings",
    });
  });

  it("shows the user menu in the footer", () => {
    renderSidebar();

    expect(screen.getByText("user menu")).toBeInTheDocument();
  });
});
