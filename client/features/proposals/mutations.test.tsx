import { useQuery } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_USER } from "@/mocks/factories/users";
import { STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { proposalsStore } from "@/mocks/stage11/proposals-store";
import { signInAs } from "@/tests/utils/api-session";
import { renderWithProviders, screen, userEvent, waitFor } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import { buildItemUpdate, describeItemUpdateError, useUpdateProposalItem } from "./mutations";
import { proposalQuery } from "./queries";
import { ApiError } from "@/lib/api/errors";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock("sonner", () => ({ toast }));

const GRACIE = STAGE_ONE_IDS.gracie;

function proposedIds(): string[] {
  const record = proposalsStore.current(GRACIE);
  return (record?.items ?? []).filter((item) => item.status === "proposed").map((item) => item.id);
}

function Harness({ firstId, secondId }: { firstId: string; secondId: string }) {
  const query = useQuery(proposalQuery(GRACIE));
  const { proposal, pendingIds, update } = useUpdateProposalItem(GRACIE, query.data ?? null);
  if (proposal === null) {
    return <p>loading</p>;
  }
  const first = proposal.items.find((item) => item.id === firstId);
  return (
    <div>
      <p data-testid="first-status">{first?.status}</p>
      <p data-testid="first-pending">{pendingIds.has(firstId) ? "yes" : "no"}</p>
      <p data-testid="selected-count">
        {proposal.items.filter((item) => item.status === "selected").length}
      </p>
      <button type="button" onClick={() => void update({ ids: [firstId], choice: "selected" })}>
        tick first
      </button>
      <button
        type="button"
        onClick={() => void update({ ids: [firstId, secondId], choice: "declined", note: "no" })}
      >
        decline two
      </button>
    </div>
  );
}

beforeEach(async () => {
  toast.error.mockClear();
  await signInAs(MEMBER_USER);
});

describe("useUpdateProposalItem", () => {
  it("shows the tick at once and keeps it once the server agrees", async () => {
    const user = userEvent.setup();
    const ids = proposedIds();
    renderWithProviders(<Harness firstId={ids[0] ?? ""} secondId={ids[1] ?? ""} />);
    await screen.findByTestId("first-status");
    expect(screen.getByTestId("first-status")).toHaveTextContent("proposed");
    const before = Number(screen.getByTestId("selected-count").textContent);

    await user.click(screen.getByRole("button", { name: "tick first" }));
    await waitFor(() => expect(screen.getByTestId("first-pending")).toHaveTextContent("yes"));
    await waitFor(() =>
      expect(screen.getByTestId("selected-count")).toHaveTextContent(String(before + 1)),
    );
    await waitFor(() => expect(screen.getByTestId("first-pending")).toHaveTextContent("no"));
    expect(screen.getByTestId("selected-count")).toHaveTextContent(String(before + 1));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("reverts and toasts with the request id when the server refuses", async () => {
    const user = userEvent.setup();
    const ids = proposedIds();
    server.use(
      http.patch("*/api/v1/proposal-items/:item_id", () =>
        HttpResponse.json(
          { error: { code: "internal_error", message: "Internal server error", details: [] } },
          { status: 500, headers: { "X-Request-ID": "req-boom" } },
        ),
      ),
    );
    renderWithProviders(<Harness firstId={ids[0] ?? ""} secondId={ids[1] ?? ""} />);
    await screen.findByTestId("first-status");
    const before = screen.getByTestId("selected-count").textContent;

    await user.click(screen.getByRole("button", { name: "tick first" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith(
      "Could not update the item",
      expect.objectContaining({ description: expect.stringContaining("req-boom") }),
    );
    await waitFor(() => expect(screen.getByTestId("first-pending")).toHaveTextContent("no"));
    expect(screen.getByTestId("first-status")).toHaveTextContent("proposed");
    expect(screen.getByTestId("selected-count")).toHaveTextContent(before ?? "");
  });

  it("counts several failures in one toast", async () => {
    const user = userEvent.setup();
    const ids = proposedIds();
    server.use(
      http.patch("*/api/v1/proposal-items/:item_id", () =>
        HttpResponse.json(
          { error: { code: "conflict", message: "Conflict", details: [] } },
          { status: 409 },
        ),
      ),
    );
    renderWithProviders(<Harness firstId={ids[0] ?? ""} secondId={ids[1] ?? ""} />);
    await screen.findByTestId("first-status");
    await user.click(screen.getByRole("button", { name: "decline two" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith(
      "Could not update 2 items",
      expect.objectContaining({ description: expect.stringContaining("reloaded") }),
    );
    expect(screen.getByTestId("first-status")).toHaveTextContent("proposed");
  });
});

describe("request helpers", () => {
  it("sends the note only when it was given", () => {
    expect(buildItemUpdate({ choice: "selected" })).toEqual({ status: "selected" });
    expect(buildItemUpdate({ choice: "declined", note: "x" })).toEqual({
      status: "declined",
      note: "x",
    });
    expect(buildItemUpdate({ choice: "proposed", note: null })).toEqual({
      status: "proposed",
      note: null,
    });
  });

  it("explains a conflict as a reload", () => {
    const conflict = new ApiError({ status: 409, code: "conflict", message: "older proposal" });
    expect(describeItemUpdateError(conflict)).toContain("reloaded");
  });
});
