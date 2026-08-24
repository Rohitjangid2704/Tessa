import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_USER } from "@/mocks/factories/users";
import { STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { signInAs } from "@/tests/utils/api-session";
import { resetLocation } from "@/tests/utils/fake-navigation";
import { renderWithProviders, screen } from "@/tests/utils/render";
import { CURRENT_TARGET_STORAGE_KEY, rememberTarget } from "./current-target";
import { CurrentTargetGate } from "./current-target-gate";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

vi.mock("next/navigation", async () => ({
  ...(await import("@/tests/utils/fake-navigation")),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const { gracie, billing } = STAGE_ONE_IDS;

function renderGate() {
  return renderWithProviders(
    <CurrentTargetGate title="Pick a target for the catalog">
      {(targetId) => <p>showing {targetId}</p>}
    </CurrentTargetGate>,
  );
}

beforeEach(async () => {
  window.localStorage.clear();
  rememberTarget(null);
  resetLocation("/catalog");
  await signInAs(MEMBER_USER);
});

describe("CurrentTargetGate", () => {
  it("hands the target of the URL to its children", () => {
    resetLocation(`/catalog?target_id=${gracie}`);
    renderGate();

    expect(screen.getByText(`showing ${gracie}`)).toBeInTheDocument();
  });

  it("falls back to the last used target", () => {
    window.localStorage.setItem(CURRENT_TARGET_STORAGE_KEY, billing);
    renderGate();

    expect(screen.getByText(`showing ${billing}`)).toBeInTheDocument();
  });

  it("asks for a target when none is known", async () => {
    renderGate();

    expect(
      await screen.findByRole("heading", { level: 2, name: "Pick a target for the catalog" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^showing/)).not.toBeInTheDocument();
  });

  it("shows a loading state instead of the picker while the stored target is unknown on the server", () => {
    window.localStorage.setItem(CURRENT_TARGET_STORAGE_KEY, gracie);

    const html = renderToString(
      <CurrentTargetGate>{(targetId) => <p>showing {targetId}</p>}</CurrentTargetGate>,
    );

    expect(html).toContain("Loading the current target");
    expect(html).not.toContain("Choose a target");
  });
});
