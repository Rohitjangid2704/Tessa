import { beforeEach, describe, expect, it, vi } from "vitest";
import { rememberTarget } from "@/features/targets/current-target";
import { MEMBER_USER } from "@/mocks/factories/users";
import { STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { signInAs } from "@/tests/utils/api-session";
import { resetLocation } from "@/tests/utils/fake-navigation";
import { renderWithProviders, screen } from "@/tests/utils/render";
import CatalogPage, { metadata } from "./page";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

vi.mock("next/navigation", async () => ({
  ...(await import("@/tests/utils/fake-navigation")),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

beforeEach(async () => {
  window.localStorage.clear();
  rememberTarget(null);
  resetLocation(`/catalog?target_id=${STAGE_ONE_IDS.gracie}`);
  await signInAs(MEMBER_USER);
});

describe("CatalogPage", () => {
  it("titles the page and lists the features of the current target", async () => {
    renderWithProviders(<CatalogPage />);

    expect(screen.getByRole("heading", { level: 1, name: "Catalog" })).toBeInTheDocument();
    expect(
      await screen.findByRole("article", { name: "smart_log.read.open_maintenance" }),
    ).toBeInTheDocument();
    expect(metadata.title).toBe("Catalog");
  });

  it("asks for a target instead of showing a placeholder when none is selected", async () => {
    resetLocation("/catalog");
    renderWithProviders(<CatalogPage />);

    expect(screen.getByRole("heading", { level: 1, name: "Catalog" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Choose a target" })).toBeInTheDocument();
  });

  it("never renders its own main landmark because the shell owns it", async () => {
    const { container } = renderWithProviders(<CatalogPage />);

    await screen.findByRole("article", { name: "smart_log.read.open_maintenance" });
    expect(container.querySelector("main")).toBeNull();
  });
});
