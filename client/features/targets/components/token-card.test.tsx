import { useQuery } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_USER, MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import { fixedToken, STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { signInAs } from "@/tests/utils/api-session";
import { renderWithProviders, screen, userEvent, waitFor, within } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import { targetQuery } from "../queries";
import { TokenCard, describeRotateError } from "./token-card";
import { ApiError } from "@/lib/api/errors";
import type { Target } from "../types";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const BASE_TARGET: Target = {
  id: STAGE_ONE_IDS.gracie,
  name: "Gracie",
  slug: "gracie",
  app_kind: "llm_assistant",
  tier: "qa",
  allow_production: false,
  target_token: fixedToken("graciedemotoken"),
  hints: {},
  latest_bundle_id: null,
  created_at: "2026-09-10T08:00:00.000Z",
  archived_at: null,
};

function LiveTokenCard() {
  const query = useQuery(targetQuery(STAGE_ONE_IDS.gracie));
  return query.data === undefined ? null : <TokenCard target={query.data} />;
}

beforeEach(async () => {
  await signInAs(MEMBER_USER);
});

describe("TokenCard", () => {
  it("shows the token and copies it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderWithProviders(<TokenCard target={BASE_TARGET} />);

    expect(screen.getByText(BASE_TARGET.target_token)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy target token" }));

    expect(writeText).toHaveBeenCalledExactlyOnceWith(BASE_TARGET.target_token);
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("asks for confirmation before rotating and does nothing on Cancel", async () => {
    let rotations = 0;
    server.use(
      http.post("*/api/v1/targets/:target_id/token/rotate", () => {
        rotations += 1;
        return undefined;
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<TokenCard target={BASE_TARGET} />);

    await user.click(await screen.findByRole("button", { name: "Rotate token" }));

    const dialog = await screen.findByRole("alertdialog", {
      name: "Rotate the token of Gracie?",
    });
    expect(dialog).toHaveTextContent("keeps matching uploads until the next rotation");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(rotations).toBe(0);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("rotates after confirmation and shows the new token from the cache", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LiveTokenCard />);
    await screen.findByText(fixedToken("graciedemotoken"));

    await user.click(await screen.findByRole("button", { name: "Rotate token" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Rotate token" }));

    await waitFor(() =>
      expect(screen.queryByText(fixedToken("graciedemotoken"))).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/^tgt_[A-Za-z0-9]{22}$/)).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("hides rotation from a viewer but still shows and copies the token", async () => {
    await signInAs(VIEWER_USER);
    renderWithProviders(<TokenCard target={BASE_TARGET} />);

    expect(screen.getByText(BASE_TARGET.target_token)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy target token" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Rotate token" })).toBeNull());
  });

  it("lets an admin rotate", async () => {
    await signInAs(ADMIN_USER);
    renderWithProviders(<TokenCard target={BASE_TARGET} />);

    expect(await screen.findByRole("button", { name: "Rotate token" })).toBeEnabled();
  });

  it("disables rotation for an archived target", async () => {
    renderWithProviders(
      <TokenCard target={{ ...BASE_TARGET, archived_at: "2026-09-20T08:00:00.000Z" }} />,
    );

    expect(await screen.findByRole("button", { name: "Rotate token" })).toBeDisabled();
  });

  it("explains a 409 from the API", async () => {
    server.use(
      http.post("*/api/v1/targets/:target_id/token/rotate", () =>
        HttpResponse.json(
          { error: { code: "conflict", message: "archived", request_id: "r", details: [] } },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<TokenCard target={BASE_TARGET} />);
    await user.click(await screen.findByRole("button", { name: "Rotate token" }));

    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Rotate token" }),
    );

    expect(
      await screen.findByText("This target is archived, so its token cannot be rotated."),
    ).toBeInTheDocument();
  });
});

describe("describeRotateError", () => {
  it("maps archived, forbidden and everything else", () => {
    expect(
      describeRotateError(new ApiError({ status: 409, code: "conflict", message: "x" })),
    ).toMatch(/archived/);
    expect(
      describeRotateError(new ApiError({ status: 403, code: "role_required", message: "x" })),
    ).toMatch(/role/);
    expect(
      describeRotateError(new ApiError({ status: 500, code: "internal_error", message: "Boom" })),
    ).toBe("Boom");
  });
});
