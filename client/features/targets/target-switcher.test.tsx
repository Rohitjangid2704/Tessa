import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_USER } from "@/mocks/factories/users";
import { STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { signInAs } from "@/tests/utils/api-session";
import { resetLocation } from "@/tests/utils/fake-navigation";
import { renderWithProviders, screen, userEvent, waitFor } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import { CURRENT_TARGET_STORAGE_KEY, rememberTarget } from "./current-target";
import { TargetSwitcher } from "./target-switcher";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", async () => ({
  ...(await import("@/tests/utils/fake-navigation")),
  useRouter: () => router,
}));

const { gracie, billing, liveShop, legacyPortal } = STAGE_ONE_IDS;

function trigger() {
  return screen.findByRole("combobox", { name: "Current target" });
}

beforeEach(async () => {
  window.localStorage.clear();
  rememberTarget(null);
  resetLocation("/catalog");
  await signInAs(MEMBER_USER);
});

describe("TargetSwitcher", () => {
  it("lists the active targets by name and marks production ones", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TargetSwitcher />);

    await user.click(await trigger());

    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Billing API",
      "Broken Import",
      "Gracie",
      "Live Shop (production)",
    ]);
  });

  it("shows a placeholder when no target is chosen yet", async () => {
    renderWithProviders(<TargetSwitcher />);

    expect(await trigger()).toHaveTextContent("Select a target");
  });

  it("shows the current target from the URL with a loud production badge", async () => {
    resetLocation(`/catalog?target_id=${liveShop}`);
    renderWithProviders(<TargetSwitcher />);

    expect(await trigger()).toHaveTextContent("Live Shop (production)");
    expect(await screen.findByText("Production")).toBeInTheDocument();
  });

  it("shows no production badge for a QA target", async () => {
    resetLocation(`/catalog?target_id=${gracie}`);
    renderWithProviders(<TargetSwitcher />);

    expect(await trigger()).toHaveTextContent("Gracie");
    expect(screen.queryByText("Production")).not.toBeInTheDocument();
  });

  it("includes an archived current target that the list leaves out", async () => {
    resetLocation(`/catalog?target_id=${legacyPortal}`);
    renderWithProviders(<TargetSwitcher />);

    await waitFor(async () =>
      expect(await trigger()).toHaveTextContent("Legacy Portal (archived)"),
    );
  });

  it("remembers the choice and replaces target_id on a page that carries it", async () => {
    resetLocation(`/catalog?target_id=${gracie}`);
    const user = userEvent.setup();
    renderWithProviders(<TargetSwitcher />);

    await user.click(await trigger());
    await user.click(await screen.findByRole("option", { name: "Billing API" }));

    expect(window.localStorage.getItem(CURRENT_TARGET_STORAGE_KEY)).toBe(billing);
    expect(router.replace).toHaveBeenCalledWith(`/catalog?target_id=${billing}`);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("navigates to the same tab of the new target from a target page", async () => {
    resetLocation(`/targets/${gracie}/bundles`);
    const user = userEvent.setup();
    renderWithProviders(<TargetSwitcher />);

    await user.click(await trigger());
    await user.click(await screen.findByRole("option", { name: "Billing API" }));

    expect(router.push).toHaveBeenCalledWith(`/targets/${billing}/bundles`);
  });

  it("only remembers the choice on a page that takes no target", async () => {
    resetLocation("/settings");
    const user = userEvent.setup();
    renderWithProviders(<TargetSwitcher />);

    await user.click(await trigger());
    await user.click(await screen.findByRole("option", { name: "Gracie" }));

    expect(window.localStorage.getItem(CURRENT_TARGET_STORAGE_KEY)).toBe(gracie);
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("forgets a remembered target that no longer exists", async () => {
    window.localStorage.setItem(CURRENT_TARGET_STORAGE_KEY, "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b9999");
    renderWithProviders(<TargetSwitcher />);

    await waitFor(() => expect(window.localStorage.getItem(CURRENT_TARGET_STORAGE_KEY)).toBeNull());
    expect(await trigger()).toHaveTextContent("Select a target");
  });

  it("offers a retry when the targets cannot be loaded", async () => {
    server.use(http.get("*/api/v1/targets", () => HttpResponse.error(), { once: true }));
    const user = userEvent.setup();
    renderWithProviders(<TargetSwitcher />);

    await user.click(await screen.findByRole("button", { name: "Targets unavailable. Retry" }));

    expect(await trigger()).toBeInTheDocument();
  });
});
