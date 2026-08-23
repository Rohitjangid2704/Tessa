import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "@/lib/api/types";
import { ADMIN_USER, MEMBER_USER } from "@/mocks/factories/users";
import { buildAuditEvent } from "@/mocks/stage11/audit-data";
import { renderWithProviders, screen, within } from "@/tests/utils/render";
import { actorLabel, AuditTable, sessionHref } from "./audit-table";
import { ViaChip } from "./via-chip";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const SESSION_ID = "0198f6f2-aaaa-7bbb-8ccc-000000000011";
const NOW = Date.parse("2026-10-09T10:00:00Z");

const VIEWPORT = { width: 1200, height: 560 };

const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => VIEWPORT.height,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => VIEWPORT.width,
  });
});

afterAll(() => {
  if (originalOffsetHeight !== undefined) {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
  }
  if (originalOffsetWidth !== undefined) {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth);
  }
});

const NAMES = new Map([
  [ADMIN_USER.id, ADMIN_USER.name],
  [MEMBER_USER.id, MEMBER_USER.name],
]);

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return buildAuditEvent(NOW, {
    action: "personal_token_write",
    subject_type: "route",
    via: "mcp",
    actor_user_id: MEMBER_USER.id,
    subject_id: "7a1b2c3d-9c00-7b00-8a00-000000000002",
    agent_session_id: SESSION_ID,
    detail: { method: "POST", path: "/api/v1/bundles", status: 201, request_id: "req-123" },
    ...overrides,
  });
}

function rowAt(index: number): HTMLElement {
  const row = screen.getAllByRole("row")[index];
  if (row === undefined) {
    throw new Error(`No row at ${index}`);
  }
  return row;
}

function renderTable(rows: AuditEvent[]) {
  return renderWithProviders(
    <AuditTable
      rows={rows}
      actorNames={NAMES}
      total={rows.length}
      hasNextPage={false}
      isFetchingNextPage={false}
      onLoadMore={vi.fn()}
    />,
  );
}

describe("AuditTable", () => {
  it("renders one row per event with actor, action, subject and via", () => {
    renderTable([event()]);

    const table = screen.getByRole("table", { name: "Audit events" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Time", "Actor", "Action", "Subject", "Via", "Session", "Request"]);
    const row = rowAt(1);
    expect(row).toHaveAttribute("data-action", "personal_token_write");
    expect(within(row).getByText(MEMBER_USER.name)).toBeInTheDocument();
    expect(within(row).getByText("Write with a personal token")).toBeInTheDocument();
    expect(within(row).getByText("API route")).toBeInTheDocument();
    expect(within(row).getByText("7a1b2c3d")).toBeInTheDocument();
  });

  it("renders detail as escaped text and never as markup", () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const { container } = renderTable([event({ detail: { note: hostile, request_id: "req-9" } })]);

    const detail = container.querySelector('[data-slot="audit-detail"]');
    expect(detail?.textContent).toBe(`note: ${hostile}`);
    const table = container.querySelector('[data-slot="audit-table"]');
    expect(table?.querySelector("img")).toBeNull();
    expect(table?.querySelector("script")).toBeNull();
  });

  it("leaves the request id out of the detail text and offers it to copy", () => {
    const { container } = renderTable([event()]);

    expect(container.querySelector('[data-slot="audit-detail"]')?.textContent).toBe(
      "method: POST, path: /api/v1/bundles, status: 201",
    );
    expect(screen.getByRole("button", { name: "Copy request id req-123" })).toBeInTheDocument();
  });

  it("shows None for a missing session and request id, and a link when there is a session", () => {
    renderTable([
      event({ agent_session_id: null, detail: {}, via: "web", id: "a1" }),
      event({ id: "a2" }),
    ]);

    const first = rowAt(1);
    const second = rowAt(2);
    expect(within(first).getAllByText("None")).toHaveLength(2);
    expect(within(first).queryByRole("link")).toBeNull();
    expect(within(second).getByRole("link")).toHaveAttribute("href", sessionHref(SESSION_ID));
    expect(sessionHref(SESSION_ID)).toBe(`/settings/activity?session=${SESSION_ID}`);
  });

  it("names a system change and an actor the user list does not know", () => {
    expect(actorLabel(event({ actor_user_id: null }), NAMES)).toBe("System");
    expect(
      actorLabel(event({ actor_user_id: "0198f6f2-1111-7000-8000-000000000001" }), NAMES),
    ).toBe("User 0198f6f2");
  });

  it("windows a long list instead of mounting every row", () => {
    const rows = Array.from({ length: 2000 }, (_, index) =>
      event({ id: `row-${index}`, created_at: new Date(NOW - index * 1000).toISOString() }),
    );
    renderTable(rows);

    const table = screen.getByRole("table", { name: "Audit events" });
    expect(table).toHaveAttribute("aria-rowcount", "2001");
    const mounted = within(table).getAllByRole("row").length;
    expect(mounted).toBeGreaterThan(5);
    expect(mounted).toBeLessThan(60);
  });

  it("asks for the next page when the window reaches the end of what is loaded", () => {
    const onLoadMore = vi.fn();
    renderWithProviders(
      <AuditTable
        rows={[event()]}
        actorNames={NAMES}
        total={500}
        hasNextPage
        isFetchingNextPage={false}
        onLoadMore={onLoadMore}
      />,
    );
    expect(onLoadMore).toHaveBeenCalled();
  });

  it("does not ask while a page is already loading or none is left", () => {
    const onLoadMore = vi.fn();
    const { rerender } = renderWithProviders(
      <AuditTable
        rows={[event()]}
        actorNames={NAMES}
        total={500}
        hasNextPage
        isFetchingNextPage
        onLoadMore={onLoadMore}
      />,
    );
    rerender(
      <AuditTable
        rows={[event()]}
        actorNames={NAMES}
        total={1}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={onLoadMore}
      />,
    );
    expect(onLoadMore).not.toHaveBeenCalled();
  });
});

describe("ViaChip", () => {
  it.each([
    ["web", "Web"],
    ["mcp", "Claude Code"],
    ["svc", "Service key"],
  ] as const)("shows %s as text with an icon", (via, label) => {
    const { container } = renderWithProviders(<ViaChip via={via} />);

    expect(screen.getByText(label)).toBeInTheDocument();
    expect(container.querySelector("[data-via]")).toHaveAttribute("data-via", via);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});
