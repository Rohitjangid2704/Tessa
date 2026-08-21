import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockState } from "@/mocks/handlers";
import { MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import { STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { CURRENT_TARGET_STORAGE_KEY, rememberTarget } from "@/features/targets/current-target";
import { signInAs } from "@/tests/utils/api-session";
import { resetLocation } from "@/tests/utils/fake-navigation";
import { renderWithProviders, screen, userEvent } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import { TargetRequired } from "./target-required";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", async () => ({
  ...(await import("@/tests/utils/fake-navigation")),
  useRouter: () => router,
}));

beforeEach(async () => {
  window.localStorage.clear();
  rememberTarget(null);
  resetLocation("/catalog");
  await signInAs(MEMBER_USER);
});

describe("TargetRequired", () => {
  it("asks for a target and offers the active targets", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TargetRequired />);

    expect(screen.getByRole("heading", { level: 2, name: "Choose a target" })).toBeInTheDocument();
    await user.click(await screen.findByRole("combobox", { name: "Choose a target" }));

    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toContain("Gracie");
    expect(options.map((option) => option.textContent)).not.toContain("Legacy Portal");
  });

  it("puts the picked target in the URL of a page that takes one and remembers it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TargetRequired />);

    await user.click(await screen.findByRole("combobox", { name: "Choose a target" }));
    await user.click(await screen.findByRole("option", { name: "Gracie" }));

    expect(window.localStorage.getItem(CURRENT_TARGET_STORAGE_KEY)).toBe(STAGE_ONE_IDS.gracie);
    expect(router.replace).toHaveBeenCalledWith(`/catalog?target_id=${STAGE_ONE_IDS.gracie}`);
  });

  it("accepts a custom title and description", () => {
    renderWithProviders(
      <TargetRequired title="Pick a target to browse" description="The catalog is per target." />,
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "Pick a target to browse" }),
    ).toBeInTheDocument();
    expect(screen.getByText("The catalog is per target.")).toBeInTheDocument();
  });

  it("points a member at New target when there are no targets", async () => {
    mockState.stageOne.reset("empty");
    renderWithProviders(<TargetRequired />);

    expect(await screen.findByRole("heading", { name: "No targets yet" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "New target" })).toHaveAttribute(
      "href",
      "/targets/new",
    );
  });

  it("shows no New target link to a viewer", async () => {
    mockState.stageOne.reset("empty");
    await signInAs(VIEWER_USER);
    renderWithProviders(<TargetRequired />);

    expect(await screen.findByRole("heading", { name: "No targets yet" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "New target" })).not.toBeInTheDocument();
  });

  it("shows the error with a retry when targets fail to load", async () => {
    server.use(
      http.get(
        "*/api/v1/targets",
        () =>
          HttpResponse.json(
            {
              error: {
                code: "internal_error",
                message: "Boom",
                request_id: "req-7654321",
                details: [],
              },
            },
            { status: 500 },
          ),
        { once: true },
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<TargetRequired />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("req-7654321");

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("combobox", { name: "Choose a target" })).toBeInTheDocument();
  });
});
