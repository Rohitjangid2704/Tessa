import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_USER } from "@/mocks/factories/users";
import { STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { signInAs } from "@/tests/utils/api-session";
import { resetLocation } from "@/tests/utils/fake-navigation";
import { renderWithProviders, screen, within } from "@/tests/utils/render";
import { CURRENT_TARGET_STORAGE_KEY, rememberTarget } from "./current-target";
import { TargetAwareShell } from "./target-aware-shell";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

vi.mock("next/navigation", async () => ({
  ...(await import("@/tests/utils/fake-navigation")),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/app-shell/user-menu", () => ({ UserMenu: () => <div>user menu</div> }));

const { gracie, billing } = STAGE_ONE_IDS;

function renderShell() {
  return renderWithProviders(
    <TargetAwareShell user={{ name: "Member", email: "member@tessa.local" }}>
      <p>page body</p>
    </TargetAwareShell>,
  );
}

function navHrefs(): Record<string, string | null> {
  const nav = screen.getByRole("navigation", { name: "Main" });
  return Object.fromEntries(
    within(nav)
      .getAllByRole("link")
      .map((link) => [link.textContent ?? "", link.getAttribute("href")]),
  );
}

beforeEach(async () => {
  window.localStorage.clear();
  rememberTarget(null);
  resetLocation("/");
  await signInAs(MEMBER_USER);
});

describe("TargetAwareShell", () => {
  it("renders the page, the sidebar and the target switcher in the header", async () => {
    renderShell();

    expect(screen.getByText("page body")).toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: "Current target" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
  });

  it("leaves nav hrefs without a target when none is known", () => {
    renderShell();

    expect(navHrefs()).toMatchObject({ Catalog: "/catalog", Runs: "/runs", Targets: "/targets" });
  });

  it("carries the target from the URL on the pages that take one", () => {
    resetLocation(`/catalog?target_id=${gracie}`);
    renderShell();

    expect(navHrefs()).toMatchObject({
      Catalog: `/catalog?target_id=${gracie}`,
      Scenarios: `/scenarios?target_id=${gracie}`,
      Runs: `/runs?target_id=${gracie}`,
      Targets: "/targets",
      Settings: "/settings",
    });
  });

  it("carries the last used target when the URL has none", () => {
    window.localStorage.setItem(CURRENT_TARGET_STORAGE_KEY, billing);
    renderShell();

    expect(navHrefs().Catalog).toBe(`/catalog?target_id=${billing}`);
  });

  it("prefers the URL target over the last used one and remembers it", () => {
    window.localStorage.setItem(CURRENT_TARGET_STORAGE_KEY, billing);
    resetLocation(`/runs?target_id=${gracie}`);
    renderShell();

    expect(navHrefs().Catalog).toBe(`/catalog?target_id=${gracie}`);
    expect(window.localStorage.getItem(CURRENT_TARGET_STORAGE_KEY)).toBe(gracie);
  });

  it("uses the target of the target page being viewed", () => {
    resetLocation(`/targets/${gracie}/bundles`);
    renderShell();

    expect(navHrefs().Catalog).toBe(`/catalog?target_id=${gracie}`);
  });
});
