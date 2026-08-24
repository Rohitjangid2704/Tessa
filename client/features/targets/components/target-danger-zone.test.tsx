import { useQuery } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_USER, MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import { STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { signInAs } from "@/tests/utils/api-session";
import { renderWithProviders, screen, userEvent, waitFor, within } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import { ApiError } from "@/lib/api/errors";
import { targetQuery } from "../queries";
import { TargetDangerZone, describeArchiveError } from "./target-danger-zone";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", async () => ({
  ...(await import("@/tests/utils/fake-navigation")),
  useRouter: () => router,
}));

function LiveZone({ id = STAGE_ONE_IDS.gracie }: { id?: string }) {
  const query = useQuery(targetQuery(id));
  return query.data === undefined ? null : <TargetDangerZone target={query.data} />;
}

beforeEach(async () => {
  await signInAs(ADMIN_USER);
});

describe("TargetDangerZone", () => {
  it("lets an admin open the archive confirmation and cancel it", async () => {
    let deletes = 0;
    server.use(
      http.delete("*/api/v1/targets/:target_id", () => {
        deletes += 1;
        return undefined;
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<LiveZone />);

    await user.click(await screen.findByRole("button", { name: "Archive target" }));

    const dialog = await screen.findByRole("alertdialog", { name: "Archive Gracie?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(deletes).toBe(0);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("archives after confirmation, marks the target archived and goes back to the list", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<LiveZone />);
    await user.click(await screen.findByRole("button", { name: "Archive target" }));

    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Archive target",
      }),
    );

    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/targets"));
    await waitFor(() =>
      expect(
        queryClient.getQueryData<{ archived_at?: string | null }>([
          "targets",
          "detail",
          STAGE_ONE_IDS.gracie,
        ])?.archived_at,
      ).toBeTruthy(),
    );
  });

  it("shows a 403 as a message and stays on the page", async () => {
    server.use(
      http.delete("*/api/v1/targets/:target_id", () =>
        HttpResponse.json(
          { error: { code: "role_required", message: "Admin", request_id: "r", details: [] } },
          { status: 403 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<LiveZone />);
    await user.click(await screen.findByRole("button", { name: "Archive target" }));

    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Archive target",
      }),
    );

    expect(await screen.findByText("Only an admin can archive a target.")).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("shows when an archived target was archived instead of the button", async () => {
    renderWithProviders(<LiveZone id={STAGE_ONE_IDS.legacyPortal} />);

    expect(await screen.findByText(/Archived/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive target" })).not.toBeInTheDocument();
    expect(document.querySelector("time")).toHaveAttribute("datetime", "2026-09-20T08:00:00.000Z");
  });

  it.each([
    ["member", MEMBER_USER],
    ["viewer", VIEWER_USER],
  ])("is not shown to a %s", async (_role, user) => {
    await signInAs(user);
    renderWithProviders(<LiveZone />);

    await waitFor(() => expect(screen.queryByText("Danger zone")).not.toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("button", { name: "Archive target" })).not.toBeInTheDocument();
  });
});

describe("describeArchiveError", () => {
  it("names the admin requirement for a 403 and passes other messages through", () => {
    expect(
      describeArchiveError(new ApiError({ status: 403, code: "role_required", message: "x" })),
    ).toBe("Only an admin can archive a target.");
    expect(
      describeArchiveError(new ApiError({ status: 500, code: "internal_error", message: "Boom" })),
    ).toBe("Boom");
  });
});
