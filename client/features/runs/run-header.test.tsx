import { beforeEach, describe, expect, it, vi } from "vitest";
import { VIEWER_USER, MEMBER_USER } from "@/mocks/factories/users";
import { signInAs } from "@/tests/utils/api-session";
import { makeRun } from "@/tests/utils/run-detail-fixtures";
import { renderWithStream } from "@/tests/utils/run-stream-harness";
import { screen, userEvent, waitFor, within } from "@/tests/utils/render";
import { knownEnvelope } from "@/tests/utils/stream-fixtures";
import { parseStreamMessage, type KnownStreamEvent } from "@/features/streams/events";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const { RunHeader } = await import("./run-header");

beforeEach(async () => {
  await signInAs(MEMBER_USER);
});

function known(wire: ReturnType<typeof knownEnvelope>): KnownStreamEvent {
  const parsed = parseStreamMessage(wire);
  if (parsed.kind !== "known") {
    throw new Error("fixture is not a known event");
  }
  return parsed.event;
}

function indicator(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-slot="live-indicator"]');
  if (element === null) {
    throw new Error("the live indicator is not rendered");
  }
  return element;
}

describe("RunHeader origin chips", () => {
  it("shows no trigger chip for a manual full run", () => {
    renderWithStream(<RunHeader />, { state: { run: makeRun() } });
    expect(screen.queryByText("From Claude Code")).not.toBeInTheDocument();
    expect(screen.queryByText("Manual")).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="run-subset"]')).toBeNull();
  });

  it("labels a run started from Claude Code and a subset of scenarios", () => {
    const base = makeRun();
    const run = {
      ...base,
      trigger: "agent",
      config_snapshot: { ...base.config_snapshot, scenario_ids: ["a", "b"] },
    } as unknown as ReturnType<typeof makeRun>;
    renderWithStream(<RunHeader />, { state: { run } });
    expect(screen.getByText("From Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Subset: 2 scenarios")).toBeInTheDocument();
    expect(screen.getByText("Invariants and API fuzz skipped")).toBeInTheDocument();
  });
});

describe("RunHeader content", () => {
  it("titles the run with its kind and short id and shows status, counters and budget", () => {
    renderWithStream(<RunHeader />, {
      state: {
        run: makeRun({
          counters: {
            scenarios_total: 8,
            scenarios_done: 3,
            pass: 2,
            fail: 1,
            flaky: 0,
            uncertain: 0,
            skipped: 0,
            steps_recorded: 14,
          },
          budget: { max_usd: 5, spent_usd: 0.4213, max_minutes: 30, elapsed_ms: 61_000 },
        }),
      },
    });

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Suite run 0198f6f2");
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("3 of 8 scenarios done")).toBeInTheDocument();
    expect(screen.getByText("$0.4213 of $5.00")).toBeInTheDocument();
    expect(screen.getByText("1 min 1 s of 30 min")).toBeInTheDocument();
    expect(screen.getByText("0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11")).toBeInTheDocument();
  });

  it("shows a skeleton while the run is not loaded", () => {
    renderWithStream(<RunHeader />, { state: { run: undefined, phase: "loading" } });

    expect(screen.getByText("Loading the run")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("links to the target, and to Temporal only for a safe http url", async () => {
    const run = makeRun({
      target_id: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e70",
      temporal_ui_url: "http://localhost:8233/namespaces/default/workflows/run-1",
    });
    renderWithStream(<RunHeader />, { state: { run } });

    const temporal = screen.getByRole("link", { name: /open in temporal/i });
    expect(temporal).toHaveAttribute(
      "href",
      "http://localhost:8233/namespaces/default/workflows/run-1",
    );
    expect(temporal).toHaveAttribute("target", "_blank");
    expect(temporal).toHaveAttribute("rel", "noopener noreferrer");
    expect(await screen.findByRole("link", { name: "details" })).toHaveAttribute(
      "href",
      "/targets/0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e70",
    );
  });

  it.each([null, "javascript:alert(1)", "not a url"])("hides the Temporal link for %s", (url) => {
    renderWithStream(<RunHeader />, { state: { run: makeRun({ temporal_ui_url: url }) } });

    expect(screen.queryByRole("link", { name: /temporal/i })).toBeNull();
  });

  it("marks a production run read only", () => {
    renderWithStream(<RunHeader />, { state: { run: makeRun({ read_only: true }) } });

    const chip = screen.getByText("Read-only");
    expect(chip).toHaveAttribute("title", expect.stringContaining("write features are skipped"));
  });

  it("does not show the read-only chip for a normal run", () => {
    renderWithStream(<RunHeader />);

    expect(screen.queryByText("Read-only")).toBeNull();
  });

  it("shows the finish time only once the run finished", () => {
    const { unmount } = renderWithStream(<RunHeader />);
    expect(screen.queryByText(/^Finished/)).toBeNull();
    unmount();

    renderWithStream(<RunHeader />, {
      state: {
        run: makeRun({ status: "completed", finished_at: "2026-09-30T14:10:00.000Z" }),
        isTerminal: true,
        isLive: false,
        status: "idle",
      },
    });
    expect(screen.getByText(/^Finished/)).toBeInTheDocument();
  });
});

describe("RunHeader states", () => {
  it("queued: shows Queued, a connecting indicator and no banner", () => {
    renderWithStream(<RunHeader />, {
      state: {
        run: makeRun({ status: "queued", started_at: null }),
        status: "connecting",
        isLive: false,
      },
    });

    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(indicator()).toHaveAttribute("data-state", "reconnecting");
    expect(indicator()).toHaveTextContent("Connecting");
    expect(screen.queryByRole("group", { name: "Connection" })).toBeNull();
    expect(screen.getByText("Started")).toBeInTheDocument();
    expect(screen.getByText("not yet")).toBeInTheDocument();
  });

  it("running live: shows a live indicator and no banner", () => {
    renderWithStream(<RunHeader />);

    expect(indicator()).toHaveAttribute("data-state", "live");
    expect(indicator()).toHaveTextContent("Live");
    expect(screen.queryByRole("group", { name: "Connection" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reconnecting: shows the banner with the attempt and the countdown", () => {
    renderWithStream(<RunHeader />, {
      state: {
        status: "reconnecting",
        isLive: false,
        attempt: 2,
        nextRetryInMs: 2000,
        nextRetryAt: Date.now() + 2000,
        message: "The connection was lost; retrying",
      },
    });

    const banner = screen.getByRole("group", { name: "Connection" });
    expect(within(banner).getByText("Reconnecting to the live stream")).toBeInTheDocument();
    expect(banner).toHaveTextContent("The connection was lost; retrying");
    expect(banner).toHaveTextContent("Attempt 2");
    expect(indicator()).toHaveTextContent("Reconnecting");
  });

  it("resyncing: tells the user the missed events are being reloaded", () => {
    renderWithStream(<RunHeader />, { state: { status: "resyncing", isLive: false } });

    const banner = screen.getByRole("group", { name: "Connection" });
    expect(within(banner).getByText("Reloading missed events")).toBeInTheDocument();
    expect(indicator()).toHaveTextContent("Resyncing");
  });

  it("failed: raises an alert with a way to reload the run", async () => {
    const restart = vi.fn();
    renderWithStream(<RunHeader />, {
      state: {
        status: "failed",
        isLive: false,
        message: "You do not have access to this stream",
        restart,
      },
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Live updates stopped");
    expect(alert).toHaveTextContent("You do not have access to this stream");
    await userEvent.click(within(alert).getByRole("button", { name: "Reload this run" }));
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("terminal: no socket banner, neutral completed badge, nothing to cancel", () => {
    renderWithStream(<RunHeader />, {
      state: {
        run: makeRun({ status: "completed", finished_at: "2026-09-30T14:10:00.000Z" }),
        status: "idle",
        isTerminal: true,
        isLive: false,
      },
    });

    const badge = screen.getByText("Completed");
    expect(badge.closest("[data-slot='status-badge']")).toHaveAttribute(
      "data-tone",
      "verdict-skipped",
    );
    expect(indicator()).toHaveTextContent("Not live");
    expect(screen.queryByRole("group", { name: "Connection" })).toBeNull();
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
  });

  it("terminal: a dropped socket never shows a reconnect banner", () => {
    renderWithStream(<RunHeader />, {
      state: {
        run: makeRun({ status: "failed" }),
        status: "reconnecting",
        isTerminal: true,
        isLive: false,
      },
    });

    expect(screen.queryByRole("group", { name: "Connection" })).toBeNull();
    expect(indicator()).toHaveTextContent("Not live");
  });

  it("canceling: shows the cancel banner and a disabled Canceling button", async () => {
    renderWithStream(<RunHeader />, { state: { run: makeRun({ status: "canceling" }) } });

    expect(screen.getByRole("group", { name: "Cancellation" })).toHaveTextContent(
      "Cancel requested",
    );
    expect(await screen.findByRole("button", { name: "Canceling" })).toBeDisabled();
  });

  it("budget_exceeded: names the cost limit from the budget.exhausted event", () => {
    renderWithStream(<RunHeader />, {
      state: {
        run: makeRun({ status: "budget_exceeded", finished_at: "2026-09-30T14:10:00.000Z" }),
        isTerminal: true,
        isLive: false,
        status: "idle",
      },
      events: [
        known(knownEnvelope("budget.exhausted", 7, { dimension: "usd", limit: 5, actual: 5.01 })),
      ],
    });

    const banner = screen.getByRole("group", { name: "Budget" });
    expect(banner).toHaveTextContent("Budget exceeded");
    expect(banner).toHaveTextContent("cost limit of $5.00 (reached $5.01)");
  });

  it("budget_exceeded: names the time limit and falls back to a plain sentence without the event", () => {
    const { unmount } = renderWithStream(<RunHeader />, {
      state: { run: makeRun({ status: "budget_exceeded" }), isTerminal: true, isLive: false },
      events: [
        known(
          knownEnvelope("budget.exhausted", 7, { dimension: "minutes", limit: 30, actual: 30 }),
        ),
      ],
    });
    expect(screen.getByRole("group", { name: "Budget" })).toHaveTextContent(
      "time limit of 30 min (reached 30 min)",
    );
    unmount();

    renderWithStream(<RunHeader />, {
      state: { run: makeRun({ status: "budget_exceeded" }), isTerminal: true, isLive: false },
    });
    expect(screen.getByRole("group", { name: "Budget" })).toHaveTextContent(
      "stopped when it reached its budget",
    );
  });
});

describe("RunHeader roles", () => {
  it("offers Cancel to a member of a running run", async () => {
    renderWithStream(<RunHeader />);

    expect(await screen.findByRole("button", { name: "Cancel run" })).toBeEnabled();
  });

  it("hides Cancel from a viewer but keeps everything readable", async () => {
    await signInAs(VIEWER_USER);
    renderWithStream(<RunHeader />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Config snapshot" })).toBeVisible(),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
    expect(screen.getByText("Running")).toBeInTheDocument();
  });
});

describe("RunHeader config snapshot", () => {
  it("opens a dialog with the pinned configuration as JSON and closes with Escape", async () => {
    renderWithStream(<RunHeader />, {
      state: {
        run: makeRun({
          config_snapshot: {
            ...makeRun().config_snapshot,
            bundle_version: 7,
            seed_hash: "seed-abc",
          },
        }),
      },
    });

    await userEvent.click(screen.getByRole("button", { name: "Config snapshot" }));

    const dialog = await screen.findByRole("dialog", { name: "Config snapshot" });
    const json = within(dialog).getByLabelText("Config snapshot JSON");
    expect(json).toHaveAttribute("tabindex", "0");
    const parsed = JSON.parse(json.textContent ?? "") as Record<string, unknown>;
    expect(parsed).toMatchObject({
      bundle_version: 7,
      seed_hash: "seed-abc",
      bundle_hash: "sha256:abc123",
    });
    expect(within(dialog).getByRole("button", { name: /copy/i })).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Config snapshot" })).toHaveFocus();
  });
});

describe("RunHeader live region", () => {
  it("has one polite status region that carries the run status and the connection", () => {
    renderWithStream(<RunHeader />);

    const region = document.querySelector('[data-slot="run-live-region"]');
    expect(region).toHaveAttribute("role", "status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "true");
    expect(region).toHaveTextContent("Run running. Live updates connected");
  });

  it("does not let the visible live chip announce on its own", () => {
    renderWithStream(<RunHeader />);

    expect(indicator()).not.toHaveAttribute("role");
    expect(document.querySelectorAll('[data-slot="run-live-region"]')).toHaveLength(1);
  });

  it("announces a terminal run without connection chatter", () => {
    renderWithStream(<RunHeader />, {
      state: {
        run: makeRun({ status: "completed" }),
        status: "idle",
        isTerminal: true,
        isLive: false,
      },
    });

    expect(document.querySelector('[data-slot="run-live-region"]')).toHaveTextContent(
      "Run completed",
    );
  });
});
