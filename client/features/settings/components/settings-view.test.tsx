import { configure } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_USER, MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import { mockState } from "@/mocks/state";
import { signInAs } from "@/tests/utils/api-session";
import { renderWithProviders, screen, userEvent, waitFor, within } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import { SettingsView } from "./settings-view";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5000 });

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", async () => ({
  ...(await import("@/tests/utils/fake-navigation")),
  useRouter: () => router,
}));

interface RecordedRequest {
  method: string;
  path: string;
  body: string;
}

let recorded: RecordedRequest[] = [];

function startRecording(): void {
  recorded = [];
  server.events.on("request:start", ({ request }) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/v1/settings") && request.method !== "GET") {
      void request
        .clone()
        .text()
        .then((body) => recorded.push({ method: request.method, path: url.pathname, body }));
    }
  });
}

function patches(): unknown[] {
  return recorded
    .filter((request) => request.method === "PATCH")
    .map((request) => JSON.parse(request.body) as unknown);
}

afterEach(() => {
  server.events.removeAllListeners();
  router.push.mockReset();
});

beforeEach(async () => {
  startRecording();
  await signInAs(ADMIN_USER);
});

const section = (name: string) => screen.getByRole("region", { name });
const modelRow = (role: string) =>
  document.querySelector(`[data-role="${role}"]`) as HTMLTableRowElement;

async function loaded(): Promise<void> {
  await screen.findByRole("region", { name: "Models and effort" });
}

async function replaceText(
  user: ReturnType<typeof userEvent.setup>,
  input: HTMLElement,
  text: string,
): Promise<void> {
  await user.clear(input);
  if (text !== "") {
    await user.type(input, text);
  }
}

describe("SettingsView loading", () => {
  it("shows a loading state and then every section", async () => {
    renderWithProviders(<SettingsView />);

    expect(screen.getByText("Loading settings")).toBeInTheDocument();
    await loaded();

    for (const name of [
      "Models and effort",
      "Thresholds",
      "Endpoints",
      "Budgets",
      "Secrets",
      "Connectivity tests",
    ]) {
      expect(section(name)).toBeInTheDocument();
    }
    expect(screen.queryByText("Loading settings")).not.toBeInTheDocument();
  });

  it("shows an error with the request id and recovers on retry", async () => {
    let failing = true;
    server.use(
      http.get("*/api/v1/settings", () =>
        failing
          ? HttpResponse.json(
              {
                error: {
                  code: "internal_error",
                  message: "Unhandled error",
                  request_id: "req-500",
                  details: [],
                },
              },
              { status: 500 },
            )
          : HttpResponse.json(mockState.stageFour.settings.read()),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<SettingsView />);

    expect(await screen.findByText("Could not load the settings")).toBeInTheDocument();
    expect(screen.getByText("Request ID: req-500")).toBeInTheDocument();

    failing = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));

    await loaded();
    expect(screen.queryByText("Could not load the settings")).not.toBeInTheDocument();
  });
});

describe("SettingsView models", () => {
  it("lists every role with its values and an env source", async () => {
    renderWithProviders(<SettingsView />);
    await loaded();

    expect(document.querySelectorAll("[data-role]")).toHaveLength(7);
    const judge = modelRow("judge");
    expect(within(judge).getByLabelText("Judge model")).toHaveValue("gpt-5-mini");
    expect(within(judge).getByLabelText("Judge max USD")).toHaveValue("0.05");
    expect(within(judge).getByLabelText("Judge timeout in seconds")).toHaveValue("60");
    expect(within(judge).getByRole("combobox", { name: "Judge effort" })).toHaveTextContent("low");
    for (const row of document.querySelectorAll("[data-role]")) {
      expect(row).toHaveAttribute("data-source", "env");
    }
    expect(screen.queryByRole("button", { name: /Reset to default/ })).not.toBeInTheDocument();
  });

  it("saves only the changed leaves, then shows the db source and the override", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsView />);
    await loaded();
    const judge = modelRow("judge");

    await replaceText(user, within(judge).getByLabelText("Judge model"), "gpt-5.2-judge");
    await user.click(within(judge).getByRole("combobox", { name: "Judge effort" }));
    await user.click(await screen.findByRole("option", { name: "high" }));
    await replaceText(user, within(judge).getByLabelText("Judge max USD"), "0.1");

    const models = section("Models and effort");
    expect(within(models).getByText("3 unsaved changes")).toBeInTheDocument();
    await user.click(within(models).getByRole("button", { name: "Save changes" }));

    expect(await within(models).findByText("3 settings saved.")).toBeInTheDocument();
    expect(patches()).toEqual([
      { models: { judge: { model: "gpt-5.2-judge", effort: "high", max_usd: 0.1 } } },
    ]);
    expect(modelRow("judge")).toHaveAttribute("data-source", "db");
    expect(modelRow("generate")).toHaveAttribute("data-source", "env");
    expect(within(modelRow("judge")).getByLabelText("Judge model")).toHaveValue("gpt-5.2-judge");
    expect(within(modelRow("judge")).getByLabelText("Judge timeout in seconds")).toHaveValue("60");
    expect(within(models).getByText("No unsaved changes")).toBeInTheDocument();
    expect(
      within(modelRow("judge")).getByRole("button", { name: "Reset to default for Judge model" }),
    ).toBeInTheDocument();
    expect(
      within(modelRow("judge")).queryByRole("button", {
        name: "Reset to default for Judge timeout in seconds",
      }),
    ).not.toBeInTheDocument();
  });

  it("validates before sending and sends nothing while a value is invalid", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsView />);
    await loaded();
    const judge = modelRow("judge");

    await replaceText(user, within(judge).getByLabelText("Judge max USD"), "lots");
    await replaceText(user, within(judge).getByLabelText("Judge timeout in seconds"), "2.5");
    await replaceText(user, within(judge).getByLabelText("Judge model"), "");
    await user.click(
      within(section("Models and effort")).getByRole("button", { name: "Save changes" }),
    );

    expect(await within(judge).findByText("Enter a number greater than 0")).toBeInTheDocument();
    expect(within(judge).getByText("Enter a whole number of at least 1")).toBeInTheDocument();
    expect(within(judge).getByText("Enter a model name")).toBeInTheDocument();
    expect(within(judge).getByLabelText("Judge max USD")).toHaveAttribute("aria-invalid", "true");
    expect(recorded).toEqual([]);
  });

  it("shows the server's 422 message on the leaf, keeps the typed value and clears the message when it is edited", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsView />);
    await loaded();
    const generate = modelRow("generate");
    const model = within(generate).getByLabelText("Generate model");

    await replaceText(user, model, "bad model!");
    await user.click(
      within(section("Models and effort")).getByRole("button", { name: "Save changes" }),
    );

    expect(
      await within(generate).findByText(/Model names use letters, digits, dot/),
    ).toBeInTheDocument();
    expect(model).toHaveValue("bad model!");
    expect(model).toHaveAttribute("aria-invalid", "true");
    expect(generate).toHaveAttribute("data-source", "env");

    await user.type(model, "x");

    await waitFor(() =>
      expect(within(generate).queryByText(/Model names use letters/)).not.toBeInTheDocument(),
    );
  });

  it("offers Reset to default only on overridden leaves and sends null for it", async () => {
    mockState.stageFour.settings.reset("overridden");
    const user = userEvent.setup();
    renderWithProviders(<SettingsView />);
    await loaded();
    const judge = modelRow("judge");

    expect(judge).toHaveAttribute("data-source", "db");
    expect(
      within(judge).getByRole("button", { name: "Reset to default for Judge effort" }),
    ).toBeInTheDocument();
    expect(
      within(judge).getByRole("button", { name: "Reset to default for Judge max USD" }),
    ).toBeInTheDocument();
    expect(
      within(judge).queryByRole("button", { name: "Reset to default for Judge model" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Reset to default for Generate/ }),
    ).not.toBeInTheDocument();

    await user.click(
      within(judge).getByRole("button", { name: "Reset to default for Judge effort" }),
    );

    expect(within(judge).getByLabelText("Judge max USD")).toBeEnabled();
    expect(within(judge).getByRole("combobox", { name: "Judge effort" })).toBeDisabled();
    expect(within(judge).getByText("Default on save")).toBeInTheDocument();
    expect(within(section("Models and effort")).getByText("1 unsaved change")).toBeInTheDocument();
    await user.click(
      within(section("Models and effort")).getByRole("button", { name: "Save changes" }),
    );

    expect(
      await within(section("Models and effort")).findByText("1 setting reset to default."),
    ).toBeInTheDocument();
    expect(patches()).toEqual([{ models: { judge: { effort: null } } }]);
    expect(modelRow("judge")).toHaveAttribute("data-source", "db");
    expect(
      within(modelRow("judge")).getByRole("combobox", { name: "Judge effort" }),
    ).toHaveTextContent("low");
    expect(
      within(modelRow("judge")).queryByRole("button", {
        name: "Reset to default for Judge effort",
      }),
    ).not.toBeInTheDocument();
  });

  it("lets a staged reset be kept and discards edits", async () => {
    mockState.stageFour.settings.reset("overridden");
    const user = userEvent.setup();
    renderWithProviders(<SettingsView />);
    await loaded();
    const judge = modelRow("judge");
    const models = section("Models and effort");

    await user.click(
      within(judge).getByRole("button", { name: "Reset to default for Judge effort" }),
    );
    await user.click(within(judge).getByRole("button", { name: "Keep override for Judge effort" }));

    expect(within(models).getByText("No unsaved changes")).toBeInTheDocument();
    expect(within(judge).getByRole("combobox", { name: "Judge effort" })).toHaveTextContent("high");

    await replaceText(user, within(judge).getByLabelText("Judge model"), "gpt-5-nano");
    expect(within(models).getByText("1 unsaved change")).toBeInTheDocument();
    await user.click(within(models).getByRole("button", { name: "Discard changes" }));

    expect(within(judge).getByLabelText("Judge model")).toHaveValue("gpt-5-mini");
    expect(within(models).getByRole("button", { name: "Save changes" })).toBeDisabled();
  });
});

describe("SettingsView thresholds, endpoints and budgets", () => {
  it("saves a threshold, shows the db badge and offers a reset for it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsView />);
    await loaded();
    const thresholds = section("Thresholds");

    await replaceText(user, within(thresholds).getByLabelText("Probe confidence"), "0.8");
    await user.click(within(thresholds).getByRole("button", { name: "Save changes" }));

    expect(await within(thresholds).findByText("1 setting saved.")).toBeInTheDocument();
    expect(patches()).toEqual([{ thresholds: { probe_confidence: 0.8 } }]);
    const field = document.querySelector(
      '[data-leaf="thresholds.probe_confidence"]',
    ) as HTMLElement;
    expect(within(field).getByText("DB override")).toBeInTheDocument();
    expect(within(field).getByRole("button", { name: /Reset to default/ })).toBeInTheDocument();
    const other = document.querySelector(
      '[data-leaf="thresholds.label_audit_rate"]',
    ) as HTMLElement;
    expect(within(other).getByText("Env default")).toBeInTheDocument();
    expect(
      within(other).queryByRole("button", { name: /Reset to default/ }),
    ).not.toBeInTheDocument();
  });

  it("rejects a threshold outside 0 to 1 without a request", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsView />);
    await loaded();
    const thresholds = section("Thresholds");

    await replaceText(
      user,
      within(thresholds).getByLabelText("Escalate to the judge below"),
      "1.5",
    );
    await user.click(within(thresholds).getByRole("button", { name: "Save changes" }));

    expect(await within(thresholds).findByText("Enter a number from 0 to 1")).toBeInTheDocument();
    expect(recorded).toEqual([]);
  });

  it("sets the Jev URL and removes it again by emptying the field", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsView />);
    await loaded();
    const endpoints = section("Endpoints");
    const jev = within(endpoints).getByLabelText("Jev URL");
    expect(jev).toHaveValue("");

    await user.type(jev, "https://jev.qa.example.test");
    await user.click(within(endpoints).getByRole("button", { name: "Save changes" }));
    expect(await within(endpoints).findByText("1 setting saved.")).toBeInTheDocument();
    expect(within(endpoints).getByLabelText("Jev URL")).toHaveValue("https://jev.qa.example.test");

    await user.clear(within(endpoints).getByLabelText("Jev URL"));
    await user.click(within(endpoints).getByRole("button", { name: "Save changes" }));

    expect(await within(endpoints).findByText("1 setting reset to default.")).toBeInTheDocument();
    expect(patches()).toEqual([
      { endpoints: { jev_url: "https://jev.qa.example.test" } },
      { endpoints: { jev_url: null } },
    ]);
    expect(within(endpoints).getByLabelText("Jev URL")).toHaveValue("");
  });

  it("rejects a Laya URL that is not http or https", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsView />);
    await loaded();
    const endpoints = section("Endpoints");

    await replaceText(user, within(endpoints).getByLabelText("Laya URL"), "laya");
    await user.click(within(endpoints).getByRole("button", { name: "Save changes" }));

    expect(
      await within(endpoints).findByText("Enter a URL like http://host:port"),
    ).toBeInTheDocument();
    expect(recorded).toEqual([]);
  });

  it("saves budgets as numbers", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsView />);
    await loaded();
    const budgets = section("Budgets");

    await replaceText(user, within(budgets).getByLabelText("Default max cost in USD"), "12.5");
    await replaceText(user, within(budgets).getByLabelText("Max concurrency"), "8");
    await user.click(within(budgets).getByRole("button", { name: "Save changes" }));

    expect(await within(budgets).findByText("2 settings saved.")).toBeInTheDocument();
    expect(patches()).toEqual([{ budgets: { default_max_usd: 12.5, max_concurrency: 8 } }]);
  });

  it("maps a server 422 of the settings_422 fault to the leaf and keeps the other sections untouched", async () => {
    mockState.faults.apply({ settings_422: true });
    const user = userEvent.setup();
    renderWithProviders(<SettingsView />);
    await loaded();
    const budgets = section("Budgets");

    await replaceText(user, within(budgets).getByLabelText("Default max cost in USD"), "9");
    await user.click(within(budgets).getByRole("button", { name: "Save changes" }));

    expect(
      await within(budgets).findByText("The mock fault settings_422 rejected this value"),
    ).toBeInTheDocument();
    expect(within(budgets).queryByText(/Could not save/)).not.toBeInTheDocument();
    expect(within(budgets).getByLabelText("Default max cost in USD")).toHaveValue("9");
    expect(within(section("Thresholds")).getByText("No unsaved changes")).toBeInTheDocument();
  });

  it("shows a save failure that no leaf owns as an alert on the section", async () => {
    server.use(
      http.patch("*/api/v1/settings", () =>
        HttpResponse.json(
          {
            error: {
              code: "internal_error",
              message: "Unhandled error",
              request_id: "req-save",
              details: [],
            },
          },
          { status: 500 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<SettingsView />);
    await loaded();
    const budgets = section("Budgets");

    await replaceText(user, within(budgets).getByLabelText("Max concurrency"), "8");
    await user.click(within(budgets).getByRole("button", { name: "Save changes" }));

    const alert = await within(budgets).findByRole("alert");
    expect(alert).toHaveTextContent("Could not save budgets");
    expect(within(budgets).getByLabelText("Max concurrency")).toHaveValue("8");
  });

  it("keeps edits in one section when another section is saved", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsView />);
    await loaded();

    await replaceText(user, within(section("Budgets")).getByLabelText("Max concurrency"), "8");
    await replaceText(
      user,
      within(section("Thresholds")).getByLabelText("Probe confidence"),
      "0.9",
    );
    await user.click(within(section("Thresholds")).getByRole("button", { name: "Save changes" }));

    expect(await within(section("Thresholds")).findByText("1 setting saved.")).toBeInTheDocument();
    expect(within(section("Budgets")).getByLabelText("Max concurrency")).toHaveValue("8");
    expect(within(section("Budgets")).getByText("1 unsaved change")).toBeInTheDocument();
  });
});

describe("SettingsView unsaved changes", () => {
  function dispatchBeforeUnload(): boolean {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }

  it("warns before unload only while a section has unsaved edits", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsView />);
    await loaded();
    expect(dispatchBeforeUnload()).toBe(false);

    await replaceText(user, within(section("Budgets")).getByLabelText("Max concurrency"), "8");
    await waitFor(() => expect(dispatchBeforeUnload()).toBe(true));

    await user.click(within(section("Budgets")).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(dispatchBeforeUnload()).toBe(false));
  });

  it("stops being dirty once the edits are saved", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsView />);
    await loaded();

    await replaceText(user, within(section("Budgets")).getByLabelText("Max concurrency"), "8");
    await waitFor(() => expect(dispatchBeforeUnload()).toBe(true));
    await user.click(within(section("Budgets")).getByRole("button", { name: "Save changes" }));

    await within(section("Budgets")).findByText("1 setting saved.");
    await waitFor(() => expect(dispatchBeforeUnload()).toBe(false));
  });
});

describe("SettingsView without the admin role", () => {
  it.each([
    ["member", MEMBER_USER],
    ["viewer", VIEWER_USER],
  ])("shows every value read-only for a %s", async (_name, account) => {
    await signInAs(account);
    renderWithProviders(<SettingsView />);
    await loaded();

    expect(screen.getByText(/You have read-only access/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save changes/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Discard changes/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reset to default/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^(Replace|Set key|Clear)/ }),
    ).not.toBeInTheDocument();
    const judge = modelRow("judge");
    expect(within(judge).getByLabelText("Judge model")).toHaveAttribute("readonly");
    expect(within(judge).getByLabelText("Judge model")).toHaveValue("gpt-5-mini");
    expect(within(judge).getByRole("combobox", { name: "Judge effort" })).toBeDisabled();
    expect(within(section("Thresholds")).getByLabelText("Probe confidence")).toHaveAttribute(
      "readonly",
    );
    for (const button of within(section("Connectivity tests")).getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
    expect(
      within(section("Connectivity tests")).getByText(/Only admins can run them/),
    ).toBeInTheDocument();
    const secrets = section("Secrets");
    expect(within(secrets).getAllByText("Set", { exact: true })).toHaveLength(3);
    expect(within(secrets).getAllByText("Not set", { exact: true })).toHaveLength(2);
  });

  it("shows the db source and the override badges to a viewer without any reset control", async () => {
    mockState.stageFour.settings.reset("overridden");
    await signInAs(VIEWER_USER);
    renderWithProviders(<SettingsView />);
    await loaded();

    expect(modelRow("judge")).toHaveAttribute("data-source", "db");
    const field = document.querySelector(
      '[data-leaf="thresholds.probe_confidence"]',
    ) as HTMLElement;
    expect(within(field).getByText("DB override")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reset to default/ })).not.toBeInTheDocument();
  });
});
