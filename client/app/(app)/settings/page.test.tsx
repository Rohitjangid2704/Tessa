import { configure } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signInAs } from "@/tests/utils/api-session";
import { renderWithProviders, screen } from "@/tests/utils/render";
import SettingsPage from "./page";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

vi.mock("next/navigation", async () => ({
  ...(await import("@/tests/utils/fake-navigation")),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5000 });

beforeEach(async () => {
  await signInAs();
});

describe("SettingsPage", () => {
  it("shows the editable sections together with the Phase 0 dependency and schema cards", async () => {
    renderWithProviders(<SettingsPage />);

    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    for (const name of [
      "Models and effort",
      "Thresholds",
      "Endpoints",
      "Budgets",
      "Secrets",
      "Connectivity tests",
    ]) {
      expect(await screen.findByRole("region", { name })).toBeInTheDocument();
    }
    expect(await screen.findByRole("region", { name: "API" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Dependencies" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Schemas" })).toBeInTheDocument();
  });
});
