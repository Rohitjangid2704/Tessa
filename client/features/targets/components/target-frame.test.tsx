import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockState } from "@/mocks/handlers";
import { MEMBER_USER } from "@/mocks/factories/users";
import { STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { signInAs } from "@/tests/utils/api-session";
import { resetLocation } from "@/tests/utils/fake-navigation";
import { renderWithProviders, screen, userEvent, within } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import { TargetFrame } from "./target-frame";
import { isTargetTabActive, targetTabs } from "./target-tabs";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

vi.mock("next/navigation", async () => await import("@/tests/utils/fake-navigation"));

const { gracie, liveShop, legacyPortal } = STAGE_ONE_IDS;

function renderFrame(targetId: string) {
  return renderWithProviders(
    <TargetFrame targetId={targetId}>
      <p>child page</p>
    </TargetFrame>,
  );
}

beforeEach(async () => {
  resetLocation(`/targets/${gracie}`);
  await signInAs(MEMBER_USER);
});

describe("TargetFrame header", () => {
  it("shows the loading header and still renders the child page while the target loads", () => {
    renderFrame(gracie);

    expect(screen.getByText("Loading the target")).toBeInTheDocument();
    expect(screen.getByText("child page")).toBeInTheDocument();
  });

  it("shows the target name as the page heading with app kind, slug and created time", async () => {
    renderFrame(gracie);

    expect(await screen.findByRole("heading", { level: 1, name: "Gracie" })).toBeInTheDocument();
    expect(screen.getByText("LLM assistant")).toBeInTheDocument();
    expect(screen.getByText("gracie")).toBeInTheDocument();
    expect(screen.getByText("QA")).toBeInTheDocument();
    const time = document.querySelector("header time");
    expect(time).toHaveAttribute("datetime", "2026-09-10T08:00:00.000Z");
    expect(screen.getByText("child page")).toBeInTheDocument();
  });

  it("shows no banner for an active QA target", async () => {
    renderFrame(gracie);
    await screen.findByRole("heading", { level: 1, name: "Gracie" });

    expect(screen.queryByText("Production target")).not.toBeInTheDocument();
    expect(screen.queryByText("This target is archived")).not.toBeInTheDocument();
  });
});

describe("TargetFrame tabs", () => {
  it("links Overview, Bundles, Environment and Proposal of this target", async () => {
    renderFrame(gracie);

    const nav = screen.getByRole("navigation", { name: "Target sections" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Overview",
      "Bundles",
      "Environment",
      "Proposal",
    ]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      `/targets/${gracie}`,
      `/targets/${gracie}/bundles`,
      `/targets/${gracie}/environment`,
      `/targets/${gracie}/proposal`,
    ]);
    await screen.findByRole("heading", { level: 1, name: "Gracie" });
  });

  it("marks Overview current on the target page", async () => {
    renderFrame(gracie);

    const nav = screen.getByRole("navigation", { name: "Target sections" });
    expect(within(nav).getByRole("link", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Bundles" })).not.toHaveAttribute("aria-current");
    await screen.findByRole("heading", { level: 1, name: "Gracie" });
  });

  it("marks Bundles current on a nested bundle page and not Overview", async () => {
    resetLocation(`/targets/${gracie}/bundles/0198f6f2`);
    renderFrame(gracie);

    const nav = screen.getByRole("navigation", { name: "Target sections" });
    expect(within(nav).getByRole("link", { name: "Bundles" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
    await screen.findByRole("heading", { level: 1, name: "Gracie" });
  });

  it("marks Environment current on the environment page", async () => {
    resetLocation(`/targets/${gracie}/environment`);
    renderFrame(gracie);

    const nav = screen.getByRole("navigation", { name: "Target sections" });
    expect(within(nav).getByRole("link", { name: "Environment" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await screen.findByRole("heading", { level: 1, name: "Gracie" });
  });

  it("is reachable by keyboard in order", async () => {
    const user = userEvent.setup();
    renderFrame(gracie);
    await screen.findByRole("heading", { level: 1, name: "Gracie" });

    await user.tab();
    expect(screen.getByRole("link", { name: "Overview" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "Bundles" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "Environment" })).toHaveFocus();
  });
});

describe("isTargetTabActive", () => {
  const [overview, bundles] = targetTabs(gracie);

  it("matches Overview only on the exact target path", () => {
    expect(isTargetTabActive(overview.href, `/targets/${gracie}`, overview.exact)).toBe(true);
    expect(isTargetTabActive(overview.href, `/targets/${gracie}/bundles`, overview.exact)).toBe(
      false,
    );
  });

  it("matches a tab on its path and below it but not on a sibling prefix", () => {
    expect(isTargetTabActive(bundles.href, `/targets/${gracie}/bundles`, bundles.exact)).toBe(true);
    expect(isTargetTabActive(bundles.href, `/targets/${gracie}/bundles/x`, bundles.exact)).toBe(
      true,
    );
    expect(isTargetTabActive(bundles.href, `/targets/${gracie}/bundlesx`, bundles.exact)).toBe(
      false,
    );
  });
});

describe("TargetFrame banners", () => {
  it("makes a production target loud and says production runs are blocked", async () => {
    resetLocation(`/targets/${liveShop}`);
    renderFrame(liveShop);

    expect(await screen.findByText("Production target")).toBeInTheDocument();
    expect(screen.getByText(/blocked until an admin allows production/)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Live Shop" }).parentElement,
    ).toHaveTextContent("Production");
  });

  it("says runs are allowed but read-only once an admin allowed production", async () => {
    const record = mockState.stageOne.findTarget(liveShop);
    if (record === undefined) {
      throw new Error("seed missing");
    }
    record.allowProduction = true;
    resetLocation(`/targets/${liveShop}`);
    renderFrame(liveShop);

    expect(await screen.findByText(/are allowed and stay read-only/)).toBeInTheDocument();
  });

  it("shows an archived banner and badge", async () => {
    resetLocation(`/targets/${legacyPortal}`);
    renderFrame(legacyPortal);

    expect(await screen.findByText("This target is archived")).toBeInTheDocument();
    expect(screen.getAllByText("Archived").length).toBeGreaterThan(0);
  });
});

describe("TargetFrame errors", () => {
  it("shows not found instead of the child page for an unknown target", async () => {
    renderFrame("0198f6f2-4c2a-7d10-9c1e-6a4f0d3b9999");

    expect(await screen.findByRole("heading", { name: "Target not found" })).toBeInTheDocument();
    expect(screen.queryByText("child page")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Target sections" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to targets" })).toHaveAttribute(
      "href",
      "/targets",
    );
  });

  it("treats an id that is not a UUID as not found", async () => {
    renderFrame("not-a-uuid");

    expect(await screen.findByRole("heading", { name: "Target not found" })).toBeInTheDocument();
  });

  it("shows a retry for any other failure and recovers", async () => {
    server.use(
      http.get(
        "*/api/v1/targets/:target_id",
        () =>
          HttpResponse.json(
            {
              error: {
                code: "internal_error",
                message: "Boom",
                request_id: "req-3216549",
                details: [],
              },
            },
            { status: 500 },
          ),
        { once: true },
      ),
    );
    const user = userEvent.setup();
    renderFrame(gracie);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load the target");
    expect(alert).toHaveTextContent("req-3216549");
    expect(screen.queryByText("child page")).not.toBeInTheDocument();

    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Gracie" })).toBeInTheDocument();
    expect(screen.getByText("child page")).toBeInTheDocument();
  });
});
