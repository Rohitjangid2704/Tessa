import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberTarget } from "@/features/targets/current-target";
import { oracleRoutes } from "@/lib/routes";
import { MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import { STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { mockState } from "@/mocks/state";
import { signInAs } from "@/tests/utils/api-session";
import { resetLocation, trackHistory } from "@/tests/utils/fake-navigation";
import { ORACLE_RESULT_IDS, ORACLE_TEMPLATE_IDS } from "@/tests/utils/oracle";
import { renderWithProviders, screen, userEvent, waitFor, within } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import OraclePage, { metadata } from "./page";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", async () => ({
  ...(await import("@/tests/utils/fake-navigation")),
  useRouter: () => router,
}));

vi.setConfig({ testTimeout: 20_000 });

const { gracie, billing } = STAGE_ONE_IDS;
const SETTLE_MS = 150;
const PENDING_VISIBLE_MS = 900;

let history: ReturnType<typeof trackHistory>;

function open(templateId: string | null = null, extra = ""): void {
  const base =
    templateId === null ? oracleRoutes.list(gracie) : oracleRoutes.template(gracie, templateId);
  resetLocation(`${base}${extra}`);
}

async function renderPage() {
  const view = renderWithProviders(<OraclePage />);
  return { ...view, user: userEvent.setup() };
}

function templateButton(name: string) {
  return screen.getByRole("button", { name: new RegExp(`^${name}`) });
}

async function runQuery(user: ReturnType<typeof userEvent.setup>) {
  const run = await screen.findByRole("button", { name: "Run query" });
  await waitFor(() => expect(run).toBeEnabled());
  await user.click(run);
}

beforeEach(async () => {
  window.localStorage.clear();
  rememberTarget(null);
  history = trackHistory();
  mockState.stageThree.oracle.configure({ settleMs: SETTLE_MS });
  open();
  await signInAs(MEMBER_USER);
});

afterEach(() => {
  history.restore();
});

describe("OraclePage chrome", () => {
  it("titles the page and never renders its own main landmark", async () => {
    const { container } = await renderPage();

    expect(screen.getByRole("heading", { level: 1, name: "Oracle" })).toBeInTheDocument();
    expect(metadata.title).toBe("Oracle");
    await screen.findByRole("button", { name: /^open_maintenance/ });
    expect(container.querySelector("main")).toBeNull();
  });

  it("asks for a target instead of listing templates when none is selected", async () => {
    resetLocation("/oracle");
    await renderPage();

    expect(await screen.findByRole("heading", { name: "Choose a target" })).toBeInTheDocument();
  });
});

describe("OraclePage list states", () => {
  it("lists the templates of the target with language, approval and not-verified badges", async () => {
    await renderPage();

    await screen.findByRole("button", { name: /^open_maintenance/ });
    expect(document.querySelectorAll("[data-template-id]")).toHaveLength(11);
    const unverified = templateButton("refresh_room_snapshot");
    expect(within(unverified).getByText("Not verified read-only")).toBeInTheDocument();
    expect(within(templateButton("staff_roster")).getByText("Python")).toBeInTheDocument();
    expect(within(templateButton("staff_roster")).getByText("Approved")).toBeInTheDocument();
    expect(within(templateButton("legacy_room_status")).getByText("Rejected")).toBeInTheDocument();
    expect(within(templateButton("open_maintenance")).getByText("Unreviewed")).toBeInTheDocument();
    expect(screen.getByText("Showing 11 of 11 templates")).toBeInTheDocument();
  });

  it("invites a selection before one is made", async () => {
    await renderPage();

    expect(await screen.findByRole("heading", { name: "Select a template" })).toBeInTheDocument();
  });

  it("guides the user to the bundles when the target has no templates", async () => {
    mockState.stageThree.reset("empty");
    await renderPage();

    expect(await screen.findByRole("heading", { name: "No oracle templates" })).toBeInTheDocument();
    expect(
      screen.getByText(/Re-run the Discovery prompt, or send the Fix-up prompt/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the bundles of this target" })).toHaveAttribute(
      "href",
      `/targets/${gracie}/bundles`,
    );
  });

  it("shows the same guidance for a target that has no valid bundle", async () => {
    resetLocation(`/oracle?target_id=${billing}`);
    await renderPage();

    expect(await screen.findByRole("heading", { name: "No oracle templates" })).toBeInTheDocument();
  });

  it("says when the target does not exist", async () => {
    resetLocation("/oracle?target_id=0198f6f2-4c2a-7d10-9c1e-000000000000");
    await renderPage();

    expect(await screen.findByRole("heading", { name: "Target not found" })).toBeInTheDocument();
  });

  it("shows the request id and retries after a server error", async () => {
    const user = userEvent.setup();
    let failures = 1;
    server.use(
      http.get("*/api/v1/oracle-templates", () => {
        if (failures > 0) {
          failures -= 1;
          return HttpResponse.json(
            {
              error: {
                code: "internal_error",
                message: "Internal server error",
                request_id: "req-list-500",
                details: [],
              },
            },
            { status: 500 },
          );
        }
        return undefined;
      }),
    );
    renderWithProviders(<OraclePage />);

    expect(
      await screen.findByRole("heading", { name: "Could not load the oracle templates" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Request ID: req-list-500")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: /^open_maintenance/ })).toBeInTheDocument();
  });
});

describe("OraclePage filters in the URL", () => {
  it("writes the approval filter to the URL, narrows the list and clears it again", async () => {
    const { user } = await renderPage();
    await screen.findByRole("button", { name: /^open_maintenance/ });

    await user.click(screen.getByRole("button", { name: "Approval: any" }));
    await user.click(await screen.findByRole("checkbox", { name: "Rejected" }));

    await waitFor(() => expect(window.location.search).toContain("approval=rejected"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^open_maintenance/ })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /^legacy_room_status/ })).toBeInTheDocument();
    expect(screen.getByText("Showing 1 of 1 template")).toBeInTheDocument();
    expect(window.location.search).toContain(`target_id=${gracie}`);

    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Clear filters" }));

    await waitFor(() => expect(window.location.search).not.toContain("approval"));
    expect(await screen.findByRole("button", { name: /^open_maintenance/ })).toBeInTheDocument();
  });

  it("writes the feature filter after a pause or Enter and filters on it", async () => {
    const { user } = await renderPage();
    await screen.findByRole("button", { name: /^open_maintenance/ });

    await user.type(
      screen.getByRole("searchbox", { name: "Feature" }),
      "streaming.job.escalation_sweep{Enter}",
    );

    await waitFor(() =>
      expect(window.location.search).toContain("feature_id=streaming.job.escalation_sweep"),
    );
    expect(await screen.findByRole("button", { name: /^escalation_rules/ })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^open_maintenance/ })).not.toBeInTheDocument(),
    );
  });

  it("restores the filters from the URL on load", async () => {
    open(null, "&approval=approved&feature_id=access.read.who_am_i");
    await renderPage();

    expect(await screen.findByRole("button", { name: /^staff_roster/ })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Feature" })).toHaveValue("access.read.who_am_i");
    expect(screen.getByRole("button", { name: "Approval: 1 selected" })).toBeInTheDocument();
    expect(document.querySelectorAll("[data-template-id]")).toHaveLength(1);
  });

  it("explains an empty filtered list and offers to show everything", async () => {
    open(null, "&approval=approved&feature_id=smart_log.read.open_maintenance");
    const { user } = await renderPage();

    expect(await screen.findByRole("heading", { name: "No templates match" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show all templates" }));

    expect(await screen.findByRole("button", { name: /^open_maintenance/ })).toBeInTheDocument();
    expect(window.location.search).not.toContain("approval");
  });
});

describe("OraclePage template detail", () => {
  it("selects a template into the URL and shows its source, badges, feature and parameters", async () => {
    const { user } = await renderPage();

    await user.click(await screen.findByRole("button", { name: /^open_maintenance/ }));

    expect(
      await screen.findByRole("heading", { level: 2, name: "open_maintenance" }),
    ).toBeInTheDocument();
    expect(window.location.search).toContain(`template_id=${ORACLE_TEMPLATE_IDS.openMaintenance}`);
    expect(history.calls.push.at(-1)).toContain("template_id=");
    expect(screen.getByRole("button", { name: /^open_maintenance/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    const detail = screen.getByRole("article");
    expect(within(detail).getByText("Read-only verified")).toBeInTheDocument();
    expect(within(detail).getByText("SQL")).toBeInTheDocument();
    expect(within(detail).getByText("smart_log.read.open_maintenance")).toBeInTheDocument();
    const source = screen.getByRole("textbox", { name: "Source of open_maintenance" });
    expect((source as HTMLTextAreaElement).value).toContain("FROM smart_log.issues");
    expect(screen.getByLabelText(/^Tenant/)).toHaveValue("gracie-demo");
    expect(screen.getByLabelText(/^As of/)).toHaveValue("2026-10-01");
    expect(screen.getByRole("combobox", { name: /^Role/ })).toHaveTextContent("front_desk");
  });

  it("shows the python source of a python template", async () => {
    open(ORACLE_TEMPLATE_IDS.staffRoster);
    await renderPage();

    const source = await screen.findByRole("textbox", { name: "Source of staff_roster" });
    expect(source).toHaveAttribute("data-language", "python");
    expect((source as HTMLTextAreaElement).value).toContain("def run(connection, params):");
  });

  it("warns about a template that is not verified read-only and keeps Run available", async () => {
    open(ORACLE_TEMPLATE_IDS.rawSqlProbe);
    await renderPage();

    expect(await screen.findByText("Not verified as read-only")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run query" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });

  it("shows a raw JSON textarea with a notice for parameters outside the supported subset", async () => {
    open(ORACLE_TEMPLATE_IDS.escalationRules);
    await renderPage();

    expect(await screen.findByRole("note")).toHaveTextContent("Edit as JSON");
    expect(screen.getByRole("textbox", { name: "Parameters (JSON)" })).toBeInTheDocument();
  });

  it("says when the selected template does not exist and clears the selection", async () => {
    open("0198f6f2-4c2a-7d10-9c1e-000000000000");
    const { user } = await renderPage();

    expect(await screen.findByRole("heading", { name: "Template not found" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to the list" }));

    expect(await screen.findByRole("heading", { name: "Select a template" })).toBeInTheDocument();
    expect(window.location.search).not.toContain("template_id");
  });

  it("lists the earlier runs and shows the one that was picked", async () => {
    open(ORACLE_TEMPLATE_IDS.openMaintenance);
    const { user } = await renderPage();

    const history = await screen.findByText("Earlier runs");
    const section = history.closest("section") as HTMLElement;
    expect(await within(section).findAllByRole("listitem")).toHaveLength(2);
    expect(
      screen.getByText("Run the query to see its rows and the expected sentence here."),
    ).toBeInTheDocument();

    const buttons = within(section).getAllByRole("button", { name: /^Show/ });
    await user.click(buttons[1] as HTMLElement);

    expect(await screen.findByText("The query failed")).toBeInTheDocument();
    const failure = document.querySelector("[data-slot=result-error]") as HTMLElement;
    expect(failure).toHaveTextContent("The oracle worker could not reach the truth database");
    expect(window.location.search).toContain(`result_id=${ORACLE_RESULT_IDS.openMaintenanceError}`);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();

    await user.click(within(section).getAllByRole("button", { name: /^Show/ })[0] as HTMLElement);
    expect(await screen.findByText("Expected sentence")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(5);
  });
});

describe("OraclePage run flow", () => {
  it("runs, shows pending, then the sentence and the rows, and enables approval", async () => {
    mockState.stageThree.oracle.configure({ settleMs: PENDING_VISIBLE_MS });
    open(ORACLE_TEMPLATE_IDS.openMaintenance);
    const { user } = await renderPage();

    await runQuery(user);

    expect(await screen.findByText(/Running the query/)).toBeInTheDocument();
    expect(window.location.search).toContain("result_id=");
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();

    const sentence = await screen.findByText(
      "4 maintenance issues are open for gracie-demo on 2026-10-01; the newest is in room 412 (plumbing).",
    );
    expect(sentence).toHaveAttribute("data-slot", "sentence-text");
    expect(screen.getAllByRole("row")).toHaveLength(5);
    expect(screen.getByText("42 ms")).toBeInTheDocument();
    expect(screen.queryByText(/Running the query/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
  });

  it("approves the template after an ok result and updates the list badge", async () => {
    open(ORACLE_TEMPLATE_IDS.openMaintenance);
    const { user } = await renderPage();
    await runQuery(user);
    await screen.findByText("Expected sentence");

    await user.click(screen.getByRole("button", { name: "Approve" }));

    expect(await screen.findByText("open_maintenance is now approved.")).toBeInTheDocument();
    await waitFor(() =>
      expect(within(templateButton("open_maintenance")).getByText("Approved")).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });

  it("starts a run with an Idempotency-Key and sends the typed parameters", async () => {
    open(ORACLE_TEMPLATE_IDS.openMaintenance);
    const { user } = await renderPage();
    const seen: Array<{ key: string | null; body: unknown }> = [];
    server.events.on("request:start", async ({ request }) => {
      if (request.method === "POST" && request.url.endsWith("/runs")) {
        seen.push({
          key: request.headers.get("Idempotency-Key"),
          body: await request.clone().json(),
        });
      }
    });

    const limit = await screen.findByLabelText(/^Row limit/);
    await user.clear(limit);
    await user.type(limit, "3");
    await runQuery(user);
    await screen.findByText("Expected sentence");
    server.events.removeAllListeners("request:start");

    expect(seen).toHaveLength(1);
    expect(seen[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[0]?.body).toEqual({
      params: {
        tenant_id: "gracie-demo",
        as_of: "2026-10-01",
        role: "front_desk",
        limit: 3,
        include_closed: false,
      },
    });
    expect(screen.getAllByRole("row")).toHaveLength(4);
  });

  it("stops polling once the result is ok", async () => {
    open(ORACLE_TEMPLATE_IDS.openMaintenance);
    const { user } = await renderPage();
    let polls = 0;
    server.events.on("request:start", ({ request }) => {
      if (request.method === "GET" && request.url.includes("/oracle-results/")) {
        polls += 1;
      }
    });

    await runQuery(user);
    await screen.findByText("Expected sentence");
    const atSettle = polls;
    await new Promise((resolve) => setTimeout(resolve, 1300));
    server.events.removeAllListeners("request:start");

    expect(atSettle).toBeGreaterThanOrEqual(1);
    expect(polls).toBe(atSettle);
  });

  it("shows a failing query as an error with its message and no approval", async () => {
    open(ORACLE_TEMPLATE_IDS.failingExport);
    const { user } = await renderPage();

    await runQuery(user);

    expect(await screen.findByText("The query failed")).toBeInTheDocument();
    expect(screen.getByText(/statement timeout/)).toBeInTheDocument();
    expect(screen.getByText("10.0 s")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByText(/The run on screen failed/)).toBeInTheDocument();
  });

  it("fails every run while the oracle_error fault is on", async () => {
    mockState.faults.apply({ oracle_error: true });
    open(ORACLE_TEMPLATE_IDS.openMaintenance);
    const { user } = await renderPage();

    await runQuery(user);

    expect(await screen.findByText("The query failed")).toBeInTheDocument();
    expect(
      screen.getByText("The oracle worker could not reach the truth database"),
    ).toBeInTheDocument();
  });

  it("flags a cut result with a banner and 200 rows", async () => {
    open(ORACLE_TEMPLATE_IDS.guestRequestsExport);
    const { user } = await renderPage();

    await runQuery(user);

    expect(
      await screen.findByText(/only the first 200 rows are stored and shown/),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(201);
  });

  it("treats a query that returned no rows as a valid result that can be approved", async () => {
    open(ORACLE_TEMPLATE_IDS.lateCheckouts);
    const { user } = await renderPage();

    await runQuery(user);

    expect(
      await screen.findByText("The query returned no rows. That is still a valid result."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No late checkouts are expected for gracie-demo on 2026-10-01."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("renders html-looking rows as text", async () => {
    open(ORACLE_TEMPLATE_IDS.openMaintenance);
    const { user, container } = await renderPage();

    await runQuery(user);

    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("blocks the run in the browser and shows Ajv errors without calling the API", async () => {
    open(ORACLE_TEMPLATE_IDS.openMaintenance);
    const { user } = await renderPage();
    let posts = 0;
    server.events.on("request:start", ({ request }) => {
      if (request.method === "POST") {
        posts += 1;
      }
    });
    const tenant = await screen.findByLabelText(/^Tenant/);
    await user.clear(tenant);
    await user.type(tenant, "ab");

    await runQuery(user);

    expect(await screen.findByText("Use at least 3 characters")).toBeInTheDocument();
    server.events.removeAllListeners("request:start");
    expect(posts).toBe(0);
  });

  it("maps a server 422 onto the field it names", async () => {
    server.use(
      http.post("*/api/v1/oracle-templates/:id/runs", () =>
        HttpResponse.json(
          {
            error: {
              code: "validation_failed",
              message: "Request validation failed",
              request_id: "req-run-422",
              details: [
                {
                  loc: ["body", "params", "tenant_id"],
                  code: "unknown_tenant",
                  message: "Tenant is not known to the truth database",
                },
              ],
            },
          },
          { status: 422 },
        ),
      ),
    );
    open(ORACLE_TEMPLATE_IDS.openMaintenance);
    const { user } = await renderPage();

    await runQuery(user);

    expect(
      await screen.findByText("Tenant is not known to the truth database"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^Tenant/)).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByText("Could not start the query")).not.toBeInTheDocument();
  });

  it("shows other failures to start a run with the request id", async () => {
    server.use(
      http.post("*/api/v1/oracle-templates/:id/runs", () =>
        HttpResponse.json(
          {
            error: {
              code: "dependency_unavailable",
              message: "Temporal is not running",
              request_id: "req-run-503",
              details: [
                { loc: ["dependency"], code: "temporal", message: "Temporal is not running" },
              ],
            },
          },
          { status: 503 },
        ),
      ),
    );
    open(ORACLE_TEMPLATE_IDS.openMaintenance);
    const { user } = await renderPage();

    await runQuery(user);

    const alert = await screen.findByText("Could not start the query");
    expect(alert.closest("[role=alert]")).toHaveTextContent("Request ID: req-run-503");
  });
});

describe("OraclePage as a viewer", () => {
  beforeEach(async () => {
    await signInAs(VIEWER_USER);
  });

  it("reads templates and results but cannot run or decide, and says why", async () => {
    open(ORACLE_TEMPLATE_IDS.openMaintenance, `&result_id=${ORACLE_RESULT_IDS.openMaintenanceOk}`);
    await renderPage();

    expect(await screen.findByText("Expected sentence")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByText("Your role is viewer, so you cannot run queries. A member can."),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Run query" })).toBeDisabled();
    expect(screen.getByLabelText(/^Tenant/)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    expect(
      screen.getByText(/Your role is viewer, so you cannot approve or reject/),
    ).toBeInTheDocument();
  });
});
