import { useQuery } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_USER, MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import { STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { signInAs } from "@/tests/utils/api-session";
import { renderWithProviders, screen, userEvent, waitFor } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import { targetQuery } from "../queries";
import { TargetSettingsCard } from "./target-settings-card";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const ERROR_BODY = (code: string, message: string, details: unknown[] = []) => ({
  error: { code, message, request_id: "req-5566778", details },
});

function LiveSettings({ id = STAGE_ONE_IDS.gracie }: { id?: string }) {
  const query = useQuery(targetQuery(id));
  return query.data === undefined ? null : <TargetSettingsCard target={query.data} />;
}

beforeEach(async () => {
  await signInAs(MEMBER_USER);
});

describe("TargetSettingsCard rename", () => {
  it("starts with the current name and nothing to save", async () => {
    renderWithProviders(<LiveSettings />);

    expect(await screen.findByLabelText("Name")).toHaveValue("Gracie");
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("saves a new trimmed name and shows it", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.patch("*/api/v1/targets/:target_id", async ({ request }) => {
        bodies.push(await request.clone().json());
        return undefined;
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<LiveSettings />);
    const input = await screen.findByLabelText("Name");

    await user.clear(input);
    await user.type(input, "  Gracie Prod  ");
    expect(screen.getByRole("button", { name: "Save name" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Gracie Prod"));
    expect(bodies).toEqual([{ name: "Gracie Prod" }]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled());
  });

  it("restores the saved name on Cancel", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LiveSettings />);
    const input = await screen.findByLabelText("Name");

    await user.type(input, "xyz");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByLabelText("Name")).toHaveValue("Gracie");
  });

  it("validates an empty name before sending", async () => {
    let patches = 0;
    server.use(
      http.patch("*/api/v1/targets/:target_id", () => {
        patches += 1;
        return undefined;
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<LiveSettings />);
    const input = await screen.findByLabelText("Name");

    await user.clear(input);
    await user.click(screen.getByRole("button", { name: "Save name" }));

    expect(await screen.findByText("Enter a name")).toBeInTheDocument();
    expect(patches).toBe(0);
  });

  it("maps a 422 to the name field", async () => {
    server.use(
      http.patch("*/api/v1/targets/:target_id", () =>
        HttpResponse.json(
          ERROR_BODY("validation_failed", "Request validation failed", [
            { loc: ["body", "name"], code: "x", message: "Name is already taken" },
          ]),
          { status: 422 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<LiveSettings />);
    await user.type(await screen.findByLabelText("Name"), " 2");

    await user.click(screen.getByRole("button", { name: "Save name" }));

    expect(await screen.findByText("Name is already taken")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");
  });

  it("explains a 409 for an archived target", async () => {
    server.use(
      http.patch("*/api/v1/targets/:target_id", () =>
        HttpResponse.json(ERROR_BODY("conflict", "archived"), { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<LiveSettings />);
    await user.type(await screen.findByLabelText("Name"), "x");

    await user.click(screen.getByRole("button", { name: "Save name" }));

    expect(
      await screen.findByText("This target is archived, so it cannot be edited."),
    ).toBeInTheDocument();
  });

  it("disables editing for an archived target", async () => {
    renderWithProviders(<LiveSettings id={STAGE_ONE_IDS.legacyPortal} />);

    expect(await screen.findByLabelText("Name")).toBeDisabled();
  });

  it("is read-only for a viewer", async () => {
    await signInAs(VIEWER_USER);
    renderWithProviders(<LiveSettings />);

    expect(
      await screen.findByText(/Renaming it needs the member or admin role/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });
});

describe("TargetSettingsCard production switch", () => {
  it("is hidden from a member", async () => {
    renderWithProviders(<LiveSettings id={STAGE_ONE_IDS.liveShop} />);

    await screen.findByLabelText("Name");
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("lets an admin allow production runs", async () => {
    await signInAs(ADMIN_USER);
    const bodies: unknown[] = [];
    server.use(
      http.patch("*/api/v1/targets/:target_id", async ({ request }) => {
        bodies.push(await request.clone().json());
        return undefined;
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<LiveSettings id={STAGE_ONE_IDS.liveShop} />);
    const toggle = await screen.findByRole("switch", {
      name: "Allow runs against this target while it is production",
    });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);

    await waitFor(() => expect(screen.getByRole("switch")).toBeChecked());
    expect(bodies).toEqual([{ allow_production: true }]);
  });

  it("shows a failure to change the switch", async () => {
    await signInAs(ADMIN_USER);
    server.use(
      http.patch("*/api/v1/targets/:target_id", () =>
        HttpResponse.json(ERROR_BODY("role_required", "Admin only"), { status: 403 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<LiveSettings id={STAGE_ONE_IDS.liveShop} />);

    await user.click(await screen.findByRole("switch"));

    expect(await screen.findByText("Your role cannot change this setting.")).toBeInTheDocument();
    expect(screen.getByRole("switch")).not.toBeChecked();
  });
});
