import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { buildEnvironmentVariable, buildHealthState } from "@/mocks/factories/environment";
import type { SaveFailure } from "../errors";
import type { EnvironmentVariable } from "../types";
import { EnvironmentForm, type EnvironmentFormProps } from "./environment-form";

const SET_AT = "2026-09-29T08:30:00.000Z";

const API_URL = buildEnvironmentVariable({
  name: "APP_API_URL",
  kind: "url",
  secret: false,
  required: true,
  purpose: "Origin of the REST API",
  interface_ids: ["rest_api", "chat_sse"],
  has_value: true,
  value: "https://app.qa.example.test",
  last_set_at: SET_AT,
});
const ADMIN_TOKEN = buildEnvironmentVariable({
  name: "APP_ADMIN_TOKEN",
  kind: "token",
  secret: true,
  required: true,
  purpose: "Bearer token of the QA admin",
  has_value: true,
  last_set_at: SET_AT,
});
const READONLY_DSN = buildEnvironmentVariable({
  name: "APP_READONLY_DSN",
  kind: "dsn",
  secret: true,
  required: true,
  purpose: "Read-only Postgres connection",
  has_value: false,
});
const TIMEOUT = buildEnvironmentVariable({
  name: "APP_TIMEOUT_SECONDS",
  kind: "number",
  secret: false,
  required: false,
  purpose: "How long a reply may take",
  has_value: true,
  value: "30",
});
const STRICT = buildEnvironmentVariable({
  name: "APP_STRICT",
  kind: "bool",
  secret: false,
  required: false,
  purpose: "Whether to refuse typed confirmations",
  has_value: false,
});
const GUEST_EMAIL = buildEnvironmentVariable({
  name: "APP_GUEST_EMAIL",
  kind: "string",
  secret: false,
  required: true,
  purpose: "Login email of the guest",
  has_value: false,
});
const LEGACY_KEY = buildEnvironmentVariable({
  name: "APP_LEGACY_KEY",
  kind: "token",
  secret: true,
  required: true,
  purpose: "Key of the retired API",
  has_value: true,
  stale: true,
});

const VARIABLES: readonly EnvironmentVariable[] = [
  API_URL,
  ADMIN_TOKEN,
  READONLY_DSN,
  TIMEOUT,
  STRICT,
  GUEST_EMAIL,
  LEGACY_KEY,
];

function renderForm(overrides: Partial<EnvironmentFormProps> = {}) {
  const onSave = vi.fn();
  const props: EnvironmentFormProps = {
    variables: VARIABLES,
    readOnlyReason: null,
    isSaving: false,
    failure: null,
    savedMessage: null,
    onSave,
    ...overrides,
  };
  const view = render(<EnvironmentForm {...props} />);
  return { ...view, onSave: props.onSave as ReturnType<typeof vi.fn> };
}

function field(name: string): HTMLElement {
  return document.querySelector(`[data-variable="${name}"]`) as HTMLElement;
}

function input(name: string): HTMLInputElement {
  return within(field(name)).getByLabelText(name) as HTMLInputElement;
}

const saveButton = () => screen.getByRole("button", { name: "Save changes" });

describe("EnvironmentForm fields by kind", () => {
  it("renders one field per variable, grouped as current and stale", () => {
    renderForm();

    expect(document.querySelectorAll("[data-slot=env-variable-field]")).toHaveLength(7);
    const staleSection = screen.getByRole("region", { name: "Not used by the latest bundle" });
    expect(within(staleSection).getByText("APP_LEGACY_KEY")).toBeInTheDocument();
    expect(within(staleSection).getByText("Stale")).toBeInTheDocument();
    expect(within(field("APP_API_URL")).queryByText("Stale")).not.toBeInTheDocument();
  });

  it("uses a URL input for a plain URL, prefilled", () => {
    renderForm();

    expect(input("APP_API_URL")).toHaveAttribute("type", "url");
    expect(input("APP_API_URL")).toHaveValue("https://app.qa.example.test");
  });

  it("uses a decimal text input for a number, prefilled", () => {
    renderForm();

    expect(input("APP_TIMEOUT_SECONDS")).toHaveAttribute("inputmode", "decimal");
    expect(input("APP_TIMEOUT_SECONDS")).toHaveValue("30");
  });

  it("uses a switch for a plain bool and says when it is not set", () => {
    renderForm();

    const strict = within(field("APP_STRICT")).getByRole("switch", { name: "APP_STRICT" });
    expect(strict).not.toBeChecked();
    expect(within(field("APP_STRICT")).getByText(/Not set, turn it on or off/)).toBeInTheDocument();
  });

  it("uses a plain text input for a string", () => {
    renderForm();

    expect(input("APP_GUEST_EMAIL")).toHaveAttribute("type", "text");
    expect(input("APP_GUEST_EMAIL")).toHaveValue("");
  });

  it("describes each variable with its purpose, interfaces and kind", () => {
    renderForm();

    const url = field("APP_API_URL");
    expect(within(url).getByText(/Origin of the REST API/)).toBeInTheDocument();
    expect(within(url).getByText("rest_api, chat_sse")).toBeInTheDocument();
    expect(within(url).getByText("URL")).toBeInTheDocument();
    expect(within(url).getByText("Required")).toBeInTheDocument();
    expect(within(field("APP_TIMEOUT_SECONDS")).getByText("Optional")).toBeInTheDocument();
  });
});

describe("EnvironmentForm secrets", () => {
  it("renders a secret as a password input that is never prefilled, with a Set badge", () => {
    renderForm();

    const token = input("APP_ADMIN_TOKEN");
    expect(token).toHaveAttribute("type", "password");
    expect(token).toHaveValue("");
    expect(token).toHaveAttribute("placeholder", "Value is set. Type to replace it.");
    expect(within(field("APP_ADMIN_TOKEN")).getByText("Set")).toBeInTheDocument();
    expect(within(field("APP_ADMIN_TOKEN")).getByText("Secret")).toBeInTheDocument();
  });

  it("never prefills a secret even if the API sent a value", () => {
    renderForm({
      variables: [{ ...ADMIN_TOKEN, value: "leaked-by-mistake" }],
    });

    expect(input("APP_ADMIN_TOKEN")).toHaveValue("");
    expect(document.body.innerHTML).not.toContain("leaked-by-mistake");
  });

  it("marks a required variable with no value as not set", () => {
    renderForm();

    expect(within(field("APP_READONLY_DSN")).getByText("Not set")).toBeInTheDocument();
    expect(input("APP_READONLY_DSN")).toHaveAttribute("placeholder", "Not set");
  });

  it("turns browser autofill off on every input", () => {
    renderForm();

    for (const element of document.querySelectorAll("input:not([type=checkbox])")) {
      expect(element).toHaveAttribute("autocomplete", "off");
    }
    expect(screen.getByRole("form", { name: "Environment variables" })).toHaveAttribute(
      "autocomplete",
      "off",
    );
  });
});

describe("EnvironmentForm saving", () => {
  it("keeps Save disabled until something changes", async () => {
    const user = userEvent.setup();
    renderForm();

    expect(saveButton()).toBeDisabled();
    expect(screen.getByText("No unsaved changes")).toBeInTheDocument();
    await user.type(input("APP_GUEST_EMAIL"), "a");

    expect(saveButton()).toBeEnabled();
    expect(screen.getByText("1 unsaved change")).toBeInTheDocument();
  });

  it("sends only the dirty variables and leaves an untouched secret out", async () => {
    const user = userEvent.setup();
    const { onSave } = renderForm();

    await user.type(input("APP_READONLY_DSN"), "postgresql://reader:pw@db.test:5432/app");
    await user.type(input("APP_GUEST_EMAIL"), "qa@example.test");
    await user.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      set: {
        APP_READONLY_DSN: "postgresql://reader:pw@db.test:5432/app",
        APP_GUEST_EMAIL: "qa@example.test",
      },
      clear: [],
    });
    expect(Object.keys(onSave.mock.calls[0]?.[0].set)).not.toContain("APP_ADMIN_TOKEN");
  });

  it("sends a bool as a string and a changed number as a string", async () => {
    const user = userEvent.setup();
    const { onSave } = renderForm();

    await user.click(within(field("APP_STRICT")).getByRole("switch"));
    await user.clear(input("APP_TIMEOUT_SECONDS"));
    await user.type(input("APP_TIMEOUT_SECONDS"), "45");
    await user.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith({
      set: { APP_STRICT: "true", APP_TIMEOUT_SECONDS: "45" },
      clear: [],
    });
  });

  it("can set a bool that was not set to false", async () => {
    const user = userEvent.setup();
    const { onSave } = renderForm();
    const strict = within(field("APP_STRICT")).getByRole("switch");

    await user.click(strict);
    await user.click(strict);
    await user.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith({ set: { APP_STRICT: "false" }, clear: [] });
  });

  it("clears a stored secret from the Clear button and can take it back", async () => {
    const user = userEvent.setup();
    const { onSave } = renderForm();
    const token = field("APP_ADMIN_TOKEN");

    await user.click(
      within(token).getByRole("button", { name: "Clear stored value of APP_ADMIN_TOKEN" }),
    );

    expect(input("APP_ADMIN_TOKEN")).toBeDisabled();
    expect(input("APP_ADMIN_TOKEN")).toHaveAttribute(
      "placeholder",
      "Will be cleared when you save",
    );
    expect(screen.getByText("1 unsaved change")).toBeInTheDocument();
    await user.click(within(token).getByRole("button", { name: "Keep value of APP_ADMIN_TOKEN" }));
    expect(input("APP_ADMIN_TOKEN")).toBeEnabled();
    expect(saveButton()).toBeDisabled();

    await user.click(
      within(token).getByRole("button", { name: "Clear stored value of APP_ADMIN_TOKEN" }),
    );
    await user.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith({ set: {}, clear: ["APP_ADMIN_TOKEN"] });
  });

  it("clears a plain value when its field is emptied", async () => {
    const user = userEvent.setup();
    const { onSave } = renderForm();

    await user.clear(input("APP_API_URL"));
    await user.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith({ set: {}, clear: ["APP_API_URL"] });
  });

  it("offers no Clear for a variable without a stored value", () => {
    renderForm();

    expect(
      within(field("APP_READONLY_DSN")).queryByRole("button", { name: /Clear/ }),
    ).not.toBeInTheDocument();
    expect(within(field("APP_GUEST_EMAIL")).queryByRole("button")).not.toBeInTheDocument();
  });

  it("discards every edit", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(input("APP_GUEST_EMAIL"), "qa@example.test");
    await user.type(input("APP_ADMIN_TOKEN"), "secret-typed");

    await user.click(screen.getByRole("button", { name: "Discard changes" }));

    expect(input("APP_GUEST_EMAIL")).toHaveValue("");
    expect(input("APP_ADMIN_TOKEN")).toHaveValue("");
    expect(saveButton()).toBeDisabled();
  });
});

describe("EnvironmentForm validation", () => {
  it("shows a message for a bad URL and does not save", async () => {
    const user = userEvent.setup();
    const { onSave } = renderForm();

    await user.clear(input("APP_API_URL"));
    await user.type(input("APP_API_URL"), "not a url");
    await user.click(saveButton());

    expect(await screen.findByText("Enter a URL like scheme://host")).toBeInTheDocument();
    expect(input("APP_API_URL")).toHaveAttribute("aria-invalid", "true");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows a message for a bad number and for a bad DSN", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.clear(input("APP_TIMEOUT_SECONDS"));
    await user.type(input("APP_TIMEOUT_SECONDS"), "soon");
    await user.type(input("APP_READONLY_DSN"), "reader@db");

    expect(await screen.findByText("Enter a finite number like 30 or 0.5")).toBeInTheDocument();
    expect(await screen.findByText("Enter a DSN like scheme://host")).toBeInTheDocument();
  });

  it("clears the message once the value is fixed", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.clear(input("APP_TIMEOUT_SECONDS"));
    await user.type(input("APP_TIMEOUT_SECONDS"), "soon");
    expect(await screen.findByText("Enter a finite number like 30 or 0.5")).toBeInTheDocument();
    await user.clear(input("APP_TIMEOUT_SECONDS"));
    await user.type(input("APP_TIMEOUT_SECONDS"), "12");

    await waitFor(() =>
      expect(screen.queryByText("Enter a finite number like 30 or 0.5")).not.toBeInTheDocument(),
    );
  });
});

describe("EnvironmentForm read-only and busy states", () => {
  it("hides Save and Clear and makes inputs read-only for a viewer", () => {
    renderForm({ readOnlyReason: "role" });

    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Clear/ })).not.toBeInTheDocument();
    expect(screen.getByText(/You have read-only access/)).toBeInTheDocument();
    expect(input("APP_API_URL")).toHaveAttribute("readonly");
    expect(input("APP_API_URL")).toHaveValue("https://app.qa.example.test");
    expect(within(field("APP_STRICT")).getByRole("switch")).toBeDisabled();
  });

  it("explains an archived target", () => {
    renderForm({ readOnlyReason: "archived" });

    expect(
      screen.getByText("This target is archived, so its environment is read-only."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  });

  it("disables the inputs and shows Saving while a save is running", () => {
    renderForm({ isSaving: true });

    expect(screen.getByRole("button", { name: "Saving" })).toBeDisabled();
    expect(input("APP_API_URL")).toBeDisabled();
    expect(input("APP_ADMIN_TOKEN")).toBeDisabled();
  });

  it("shows a save failure and puts a server message on the variable it names", () => {
    const failure: SaveFailure = {
      message: "Your role cannot change environment values.",
      fieldMessages: { APP_API_URL: "A url variable needs a value like scheme://host" },
    };

    renderForm({ failure });

    expect(document.querySelector("[data-slot=save-failure]")).toBeInTheDocument();
    expect(screen.getByText("Could not save the environment")).toBeInTheDocument();
    expect(screen.getByText("Your role cannot change environment values.")).toBeInTheDocument();
    expect(
      within(field("APP_API_URL")).getByText("A url variable needs a value like scheme://host"),
    ).toBeInTheDocument();
    expect(input("APP_API_URL")).toHaveAttribute("aria-invalid", "true");
  });

  it("announces a saved message in a status region", () => {
    renderForm({ savedMessage: "Saved: 1 value set." });

    expect(screen.getByRole("status")).toHaveTextContent("Saved: 1 value set.");
  });

  it("shows the health of a variable that was checked", () => {
    renderForm({
      variables: [
        {
          ...API_URL,
          health: buildHealthState({
            status: "failed",
            checked_at: SET_AT,
            message: "Connection refused or host unreachable",
          }),
        },
      ],
    });

    const url = field("APP_API_URL");
    expect(within(url).getByText("Failed")).toBeInTheDocument();
    expect(within(url).getByText("Connection refused or host unreachable")).toBeInTheDocument();
  });

  it("shows no health tick for a variable that was never checked", () => {
    renderForm({ variables: [API_URL] });

    expect(within(field("APP_API_URL")).queryByText("Unchecked")).not.toBeInTheDocument();
  });
});
