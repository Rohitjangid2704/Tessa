import { configure } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretStatus } from "@/lib/api/types";
import { ADMIN_USER } from "@/mocks/factories/users";
import { signInAs } from "@/tests/utils/api-session";
import { renderWithProviders, screen, userEvent, waitFor, within } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import { SECRET_DEFINITIONS } from "../schemas";
import { SecretField } from "./secret-field";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5000 });

const TYPED_SECRET = "dev-only-unit-secret-5e7c19";

const OPENAI = SECRET_DEFINITIONS[0]!;
const SLACK = SECRET_DEFINITIONS[3]!;

const FROM_ENV: SecretStatus = {
  name: "openai_api_key",
  has_value: true,
  last_set_at: null,
  last_set_by: null,
  source: "env",
};

const FROM_DB: SecretStatus = {
  name: "openai_api_key",
  has_value: true,
  last_set_at: "2026-09-28T09:15:00.000Z",
  last_set_by: ADMIN_USER.id,
  source: "db",
};

const UNSET: SecretStatus = {
  name: "openai_api_key",
  has_value: false,
  last_set_at: null,
  last_set_by: null,
  source: null,
};

beforeEach(async () => {
  await signInAs(ADMIN_USER);
});

function renderField(
  status: SecretStatus | undefined,
  options: { readOnly?: boolean; definition?: (typeof SECRET_DEFINITIONS)[number] } = {},
) {
  return renderWithProviders(
    <ul>
      <SecretField
        definition={options.definition ?? OPENAI}
        status={status}
        readOnly={options.readOnly ?? false}
      />
    </ul>,
  );
}

function domHoldsSecret(): boolean {
  const inputValues = Array.from(document.querySelectorAll("input")).map((input) => input.value);
  return (
    document.body.innerHTML.includes(TYPED_SECRET) ||
    inputValues.some((value) => value.includes(TYPED_SECRET))
  );
}

function openEditor(user: ReturnType<typeof userEvent.setup>, name: RegExp = /^Replace/) {
  return user.click(screen.getByRole("button", { name }));
}

describe("SecretField status", () => {
  it("shows a key from the environment as set and offers Replace but no Clear", () => {
    renderField(FROM_ENV);

    expect(screen.getByText("Set", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("From environment")).toBeInTheDocument();
    expect(screen.getByText(/Provided by the deployment environment/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace OpenAI API key" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Clear/ })).not.toBeInTheDocument();
  });

  it("shows a stored key with its set time and offers Replace and Clear", () => {
    renderField(FROM_DB);

    expect(screen.getByText("Stored in Tessa")).toBeInTheDocument();
    expect(document.querySelector("time")).toHaveAttribute("datetime", "2026-09-28T09:15:00.000Z");
    expect(screen.getByRole("button", { name: "Replace OpenAI API key" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear OpenAI API key" })).toBeInTheDocument();
  });

  it("shows a missing key as not set and offers Set key", () => {
    renderField(UNSET);

    expect(screen.getByText("Not set", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("No key is set.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set key OpenAI API key" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Clear/ })).not.toBeInTheDocument();
  });

  it("treats a status the API did not send as not set", () => {
    renderField(undefined);

    expect(screen.getByText("Not set", { exact: true })).toBeInTheDocument();
  });

  it("never renders a value, even if one slipped into the status", () => {
    const leaky = { ...FROM_DB, value: TYPED_SECRET } as SecretStatus;

    renderField(leaky);

    expect(domHoldsSecret()).toBe(false);
  });

  it("offers no control to someone who cannot change keys", () => {
    renderField(FROM_DB, { readOnly: true });

    expect(screen.getByText("Stored in Tessa")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("SecretField replacing a key", () => {
  it("opens a password input that is empty, never autofilled and focused", async () => {
    const user = userEvent.setup();
    renderField(FROM_DB);

    await openEditor(user);

    const input = screen.getByLabelText("New value for OpenAI API key");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
  });

  it("sends the typed value, empties the input while the request runs and leaves nothing in the DOM", async () => {
    const bodies: string[] = [];
    server.use(
      http.put("*/api/v1/settings/secrets/:name", async ({ request }) => {
        bodies.push(await request.text());
        await delay(1000);
        return HttpResponse.json({ ...FROM_DB, last_set_at: "2026-10-05T10:00:00.000Z" });
      }),
    );
    const user = userEvent.setup();
    const { queryClient } = renderField(UNSET);
    await openEditor(user, /^Set key/);
    const input = screen.getByLabelText("New value for OpenAI API key") as HTMLInputElement;
    await user.click(input);
    await user.paste(TYPED_SECRET);
    expect(input.value).toBe(TYPED_SECRET);

    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(input).toHaveValue("");
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "Saving" })).toBeDisabled();
    expect(domHoldsSecret()).toBe(false);
    await waitFor(() => expect(bodies).toEqual([JSON.stringify({ value: TYPED_SECRET })]));
    await waitFor(() =>
      expect(screen.queryByLabelText("New value for OpenAI API key")).not.toBeInTheDocument(),
    );
    expect(
      screen.getByText("OpenAI API key saved. It is stored write-only and never shown again."),
    ).toBeInTheDocument();
    expect(domHoldsSecret()).toBe(false);
    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0));
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain(TYPED_SECRET);
  });

  it("updates the settings in the cache with the returned status only", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderField(UNSET);
    queryClient.setQueryData(["settings"], {
      secrets: { openai_api_key: UNSET, jev_api_key: UNSET },
    });
    await openEditor(user, /^Set key/);
    await user.type(screen.getByLabelText("New value for OpenAI API key"), TYPED_SECRET);

    await user.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() =>
      expect(
        (queryClient.getQueryData(["settings"]) as { secrets: Record<string, SecretStatus> })
          .secrets.openai_api_key?.has_value,
      ).toBe(true),
    );
    const cached = queryClient.getQueryData(["settings"]) as {
      secrets: Record<string, SecretStatus>;
    };
    expect(cached.secrets.jev_api_key).toEqual(UNSET);
    expect(cached.secrets.openai_api_key).toMatchObject({ source: "db", name: "openai_api_key" });
    expect(JSON.stringify(cached)).not.toContain(TYPED_SECRET);
  });

  it("shows the server's message after a failed save, with the input empty and no secret left anywhere", async () => {
    server.use(
      http.put("*/api/v1/settings/secrets/:name", () =>
        HttpResponse.json(
          {
            error: {
              code: "validation_failed",
              message: "Request validation failed",
              request_id: "req-secret",
              details: [
                { loc: ["body", "value"], code: "invalid", message: "The key was rejected" },
              ],
            },
          },
          { status: 422 },
        ),
      ),
    );
    const user = userEvent.setup();
    const { queryClient } = renderField(FROM_DB);
    await openEditor(user);
    await user.type(screen.getByLabelText("New value for OpenAI API key"), TYPED_SECRET);

    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(await screen.findByText("The key was rejected")).toBeInTheDocument();
    const input = screen.getByLabelText("New value for OpenAI API key");
    expect(input).toHaveValue("");
    expect(input).toBeEnabled();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(domHoldsSecret()).toBe(false);
    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0));
  });

  it("needs a value and sends nothing for an empty input", async () => {
    let puts = 0;
    server.use(
      http.put("*/api/v1/settings/secrets/:name", () => {
        puts += 1;
        return HttpResponse.json(FROM_DB);
      }),
    );
    const user = userEvent.setup();
    renderField(UNSET);
    await openEditor(user, /^Set key/);

    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(await screen.findByText("Enter the key")).toBeInTheDocument();
    expect(puts).toBe(0);
  });

  it("asks for an https URL for the Slack webhook before sending", async () => {
    let puts = 0;
    server.use(
      http.put("*/api/v1/settings/secrets/:name", () => {
        puts += 1;
        return HttpResponse.json(FROM_DB);
      }),
    );
    const user = userEvent.setup();
    renderField({ ...UNSET, name: "slack_webhook_url" }, { definition: SLACK });
    await openEditor(user, /^Set key/);

    await user.type(
      screen.getByLabelText("New value for Slack webhook URL"),
      "http://hooks.example.test/x",
    );
    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(await screen.findByText("A Slack webhook is an https URL")).toBeInTheDocument();
    expect(puts).toBe(0);
  });

  it("saves with Enter and closes with Cancel", async () => {
    const user = userEvent.setup();
    renderField(UNSET);
    await openEditor(user, /^Set key/);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("New value for OpenAI API key")).not.toBeInTheDocument();

    await openEditor(user, /^Set key/);
    await user.type(
      screen.getByLabelText("New value for OpenAI API key"),
      `${TYPED_SECRET}{Enter}`,
    );

    expect(await screen.findByText(/saved\. It is stored write-only/)).toBeInTheDocument();
  });
});

describe("SecretField clearing a key", () => {
  it("asks first, clears with a DELETE and says so", async () => {
    const deletes: string[] = [];
    server.use(
      http.delete("*/api/v1/settings/secrets/:name", ({ params }) => {
        deletes.push(String(params.name));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    const { queryClient } = renderField(FROM_DB);
    queryClient.setQueryData(["settings"], { secrets: {} });

    await user.click(screen.getByRole("button", { name: "Clear OpenAI API key" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Clear the OpenAI API key?" });
    expect(deletes).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Clear key" }));

    expect(await screen.findByText("OpenAI API key cleared.")).toBeInTheDocument();
    expect(deletes).toEqual(["openai_api_key"]);
    expect(queryClient.getQueryState(["settings"])?.isInvalidated).toBe(true);
  });

  it("does nothing when the confirmation is cancelled", async () => {
    let deletes = 0;
    server.use(
      http.delete("*/api/v1/settings/secrets/:name", () => {
        deletes += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderField(FROM_DB);

    await user.click(screen.getByRole("button", { name: "Clear OpenAI API key" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }),
    );

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(deletes).toBe(0);
  });

  it("shows the failure on the row when the DELETE fails", async () => {
    server.use(
      http.delete("*/api/v1/settings/secrets/:name", () =>
        HttpResponse.json(
          {
            error: { code: "forbidden", message: "Requires admin", request_id: "r-1", details: [] },
          },
          { status: 403 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderField(FROM_DB);

    await user.click(screen.getByRole("button", { name: "Clear OpenAI API key" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Clear key" }),
    );

    expect(await screen.findByText("Only admins can change settings.")).toBeInTheDocument();
  });
});
