import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import { STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { buildAgentSession } from "@/mocks/stage11/agent-sessions-data";
import { agentSessionsStore } from "@/mocks/stage11/agent-sessions-store";
import { signInAs } from "@/tests/utils/api-session";
import { renderWithProviders, screen, userEvent, waitFor, within } from "@/tests/utils/render";
import { AgentSessionsPanel } from "./agent-sessions-panel";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

vi.mock("../use-agent-sessions-feed", () => ({ useAgentSessionsFeed: () => undefined }));

const { gracie, billing } = STAGE_ONE_IDS;
const HOUR_MS = 3_600_000;
const LONG_SUMMARY = `Explained two findings and re-ran the failing scenarios. ${"More detail. ".repeat(20)}`;

beforeEach(async () => {
  window.localStorage.clear();
  agentSessionsStore.load("none");
  await signInAs(VIEWER_USER);
});

function rows() {
  return screen.getAllByRole("listitem");
}

async function firstRow(): Promise<HTMLElement> {
  const [row] = await screen.findAllByRole("listitem");
  if (row === undefined) {
    throw new Error("No session row rendered");
  }
  return row;
}

describe("AgentSessionsPanel", () => {
  it("invites the first session when nobody has worked on the target", async () => {
    renderWithProviders(<AgentSessionsPanel targetId={gracie} />);

    expect(await screen.findByText(/No Claude Code session has worked/)).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("shows one open session as active with its user, folder and writes", async () => {
    agentSessionsStore.add(
      buildAgentSession(Date.now() - HOUR_MS / 4, {
        user_id: MEMBER_USER.id,
        target_id: gracie,
        cwd_label: "gracie-backend",
        write_count: 3,
      }),
    );
    renderWithProviders(<AgentSessionsPanel targetId={gracie} />);

    const row = await firstRow();
    expect(row).toHaveAttribute("data-state", "active");
    expect(within(row).getByText(MEMBER_USER.name)).toBeInTheDocument();
    expect(within(row).getByText("Active")).toBeInTheDocument();
    expect(within(row).getByText("gracie-backend")).toBeInTheDocument();
    expect(within(row).getByText("3 writes")).toBeInTheDocument();
    expect(within(row).queryByText(/^Ended/)).toBeNull();
  });

  it("shows an ended session with its end time and summary", async () => {
    const now = Date.now();
    agentSessionsStore.add(
      buildAgentSession(now - 3 * HOUR_MS, {
        user_id: MEMBER_USER.id,
        target_id: gracie,
        ended_at: new Date(now - 2 * HOUR_MS).toISOString(),
        summary: "Discovered the bundle.",
        write_count: 1,
      }),
    );
    renderWithProviders(<AgentSessionsPanel targetId={gracie} />);

    const row = await firstRow();
    expect(row).toHaveAttribute("data-state", "ended");
    expect(
      within(row).getByText("Ended", { selector: "[data-slot='status-badge']" }),
    ).toBeInTheDocument();
    expect(within(row).getByText("Discovered the bundle.")).toBeInTheDocument();
    expect(within(row).getByText("1 write")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /Show more/ })).toBeNull();
  });

  it("marks an open session older than twelve hours as inactive", async () => {
    agentSessionsStore.add(
      buildAgentSession(Date.now() - 13 * HOUR_MS, {
        user_id: MEMBER_USER.id,
        target_id: gracie,
      }),
    );
    renderWithProviders(<AgentSessionsPanel targetId={gracie} />);

    const row = await firstRow();
    expect(row).toHaveAttribute("data-state", "inactive");
    expect(within(row).getByText("Inactive")).toHaveAttribute(
      "title",
      expect.stringContaining("12 hours"),
    );
    expect(within(row).queryByText("Active")).toBeNull();
  });

  it("clamps a long summary to two lines and expands it on request", async () => {
    agentSessionsStore.add(
      buildAgentSession(Date.now() - HOUR_MS, {
        user_id: MEMBER_USER.id,
        target_id: gracie,
        ended_at: new Date().toISOString(),
        summary: LONG_SUMMARY,
      }),
    );
    renderWithProviders(<AgentSessionsPanel targetId={gracie} />);

    const summary = await screen.findByText(/Explained two findings/);
    expect(summary).toHaveClass("line-clamp-2");
    const toggle = screen.getByRole("button", { name: "Show more" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(toggle);

    expect(summary).not.toHaveClass("line-clamp-2");
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("renders a summary as text, never as markup", async () => {
    agentSessionsStore.add(
      buildAgentSession(Date.now() - HOUR_MS, {
        user_id: MEMBER_USER.id,
        target_id: gracie,
        ended_at: new Date().toISOString(),
        summary: '<img src=x onerror="alert(1)">',
      }),
    );
    const { container } = renderWithProviders(<AgentSessionsPanel targetId={gracie} />);

    expect(await screen.findByText('<img src=x onerror="alert(1)">')).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("lists only the sessions of its own target, newest five first", async () => {
    const now = Date.now();
    for (let index = 0; index < 7; index += 1) {
      agentSessionsStore.add(
        buildAgentSession(now - (index + 1) * HOUR_MS, {
          user_id: MEMBER_USER.id,
          target_id: gracie,
          cwd_label: `folder-${index}`,
        }),
      );
    }
    agentSessionsStore.add(
      buildAgentSession(now - HOUR_MS / 2, {
        user_id: MEMBER_USER.id,
        target_id: billing,
        cwd_label: "billing-folder",
      }),
    );
    renderWithProviders(<AgentSessionsPanel targetId={gracie} />);

    await waitFor(() => expect(rows()).toHaveLength(5));
    expect(screen.queryByText("billing-folder")).toBeNull();
    expect(screen.getByText("folder-0")).toBeInTheDocument();
    expect(screen.queryByText("folder-6")).toBeNull();
    expect(screen.getByText("Showing the newest 5 of 7 sessions.")).toBeInTheDocument();
  });
});
