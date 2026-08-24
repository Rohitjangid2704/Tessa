import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_USER } from "@/mocks/factories/users";
import { mockState } from "@/mocks/state";
import { signInAs } from "@/tests/utils/api-session";
import {
  ORACLE_RESULT_IDS,
  ORACLE_TEMPLATE_IDS,
  pendingResult,
  resultFixture,
  templateFixture,
} from "@/tests/utils/oracle";
import { renderWithProviders, screen, userEvent, waitFor } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import { ApprovalBar, approvalGate, type ApprovalBarProps } from "./approval-bar";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

beforeEach(async () => {
  await signInAs(MEMBER_USER);
});

const verified = { read_only_verified: true };
const unverified = { read_only_verified: false };
const ok = { status: "ok" } as const;

describe("approvalGate", () => {
  it("allows a member to decide on a finished result of a verified template", () => {
    expect(
      approvalGate({ canReview: true, accessKnown: true, template: verified, result: ok }),
    ).toEqual({ allowed: true });
  });

  it("explains each reason in the order viewer, unverified, no result, pending, failed", () => {
    const reason = (input: Parameters<typeof approvalGate>[0]) => {
      const gate = approvalGate(input);
      return gate.allowed ? null : gate.reason;
    };

    expect(
      reason({ canReview: false, accessKnown: true, template: unverified, result: ok }),
    ).toMatch(/viewer/);
    expect(
      reason({ canReview: true, accessKnown: true, template: unverified, result: ok }),
    ).toMatch(/not verified as read-only/);
    expect(
      reason({ canReview: true, accessKnown: true, template: verified, result: undefined }),
    ).toMatch(/Run the query/);
    expect(
      reason({
        canReview: true,
        accessKnown: true,
        template: verified,
        result: { status: "pending" },
      }),
    ).toMatch(/Wait for the run/);
    expect(
      reason({
        canReview: true,
        accessKnown: true,
        template: verified,
        result: { status: "error" },
      }),
    ).toMatch(/failed/);
  });

  it("does not claim the viewer role while the role is still unknown", () => {
    const gate = approvalGate({
      canReview: false,
      accessKnown: false,
      template: verified,
      result: ok,
    });

    expect(gate).toEqual({ allowed: true });
  });
});

function renderBar(overrides: Partial<ApprovalBarProps> = {}) {
  const props: ApprovalBarProps = {
    template: templateFixture(ORACLE_TEMPLATE_IDS.openMaintenance),
    result: resultFixture(ORACLE_RESULT_IDS.openMaintenanceOk),
    canReview: true,
    accessKnown: true,
    ...overrides,
  };
  return renderWithProviders(<ApprovalBar {...props} />);
}

function approve() {
  return screen.getByRole("button", { name: "Approve" });
}

function reject() {
  return screen.getByRole("button", { name: "Reject" });
}

describe("ApprovalBar", () => {
  it("enables Approve and Reject once a finished result is on screen", () => {
    renderBar();

    expect(approve()).toBeEnabled();
    expect(reject()).toBeEnabled();
    expect(screen.getByText("Unreviewed")).toBeInTheDocument();
  });

  it("disables both buttons and says why when there is no result on screen", () => {
    renderBar({ result: undefined });

    expect(approve()).toBeDisabled();
    expect(reject()).toBeDisabled();
    const reason = screen.getByText("Run the query and review its rows before you decide.");
    expect(approve()).toHaveAttribute("aria-describedby", reason.id);
  });

  it("disables both buttons while the result on screen is pending or failed", () => {
    const { unmount } = renderBar({ result: pendingResult() });
    expect(approve()).toBeDisabled();
    expect(screen.getByText(/Wait for the run to finish/)).toBeInTheDocument();
    unmount();

    renderBar({ result: resultFixture(ORACLE_RESULT_IDS.openMaintenanceError) });
    expect(approve()).toBeDisabled();
    expect(screen.getByText(/The run on screen failed/)).toBeInTheDocument();
  });

  it("disables both buttons for a template that is not verified read-only", () => {
    renderBar({ template: templateFixture(ORACLE_TEMPLATE_IDS.rawSqlProbe) });

    expect(approve()).toBeDisabled();
    expect(reject()).toBeDisabled();
    expect(screen.getByText(/not verified as read-only/)).toBeInTheDocument();
  });

  it("disables both buttons for a viewer and names the role", () => {
    renderBar({ canReview: false });

    expect(approve()).toBeDisabled();
    expect(reject()).toBeDisabled();
    expect(screen.getByText(/Your role is viewer/)).toBeInTheDocument();
  });

  it("disables the button that matches the current decision", () => {
    const { unmount } = renderBar({
      template: templateFixture(ORACLE_TEMPLATE_IDS.issueDetail),
      result: resultFixture(ORACLE_RESULT_IDS.issueDetailOk),
    });
    expect(approve()).toBeDisabled();
    expect(reject()).toBeEnabled();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    unmount();

    renderBar({
      template: templateFixture(ORACLE_TEMPLATE_IDS.legacyRoomStatus),
      result: resultFixture(ORACLE_RESULT_IDS.legacyRoomStatusOk),
    });
    expect(reject()).toBeDisabled();
    expect(approve()).toBeEnabled();
    expect(screen.getByText("Rejected")).toBeInTheDocument();
  });

  it("approves with the result on screen and announces the new state", async () => {
    const user = userEvent.setup();
    renderBar();

    await user.click(approve());

    await waitFor(() =>
      expect(screen.getByText("open_maintenance is now approved.")).toBeInTheDocument(),
    );
    expect(screen.getByRole("status")).toHaveTextContent("open_maintenance is now approved.");
    expect(
      mockState.stageThree.oracle.findTemplate(ORACLE_TEMPLATE_IDS.openMaintenance)?.approval,
    ).toBe("approved");
  });

  it("shows the server message and request id when the decision fails", async () => {
    const user = userEvent.setup();
    server.use(
      http.put("*/api/v1/oracle-templates/:id/approval", () =>
        HttpResponse.json(
          {
            error: {
              code: "conflict",
              message: "Only a finished result with status ok can be approved or rejected",
              request_id: "req-approval-1",
              details: [],
            },
          },
          { status: 409 },
        ),
      ),
    );
    renderBar();

    await user.click(reject());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not save the decision");
    expect(alert).toHaveTextContent("Only a finished result with status ok");
    expect(alert).toHaveTextContent("Request ID: req-approval-1");
  });
});
