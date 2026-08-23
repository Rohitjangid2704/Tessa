import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/lib/api/query-keys";
import { ADMIN_USER, MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import { mockState } from "@/mocks/handlers";
import { stageFourId } from "@/mocks/stage4/label-seed";
import { signInAs } from "@/tests/utils/api-session";
import { renderWithProviders, screen, userEvent, waitFor } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import { OwnLabelChip, type OwnLabelChipProps } from "./own-label";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));

vi.mock("sonner", () => ({ toast: toastMocks }));

const JUDGE_RESULT_ID = stageFourId("subject", 601);
const STEP_ID = stageFourId("step", 601);
const RUN_ID = stageFourId("run", 6);
const LABELED_AT = "2026-10-03T08:00:00.000Z";

function seedLabel(
  userId: string,
  value: "pass" | "fail" | "uncertain",
  note: string | null = null,
) {
  mockState.stageFour.labels.saveHuman(
    userId,
    { subject_type: "judge_result", subject_id: JUDGE_RESULT_ID, value, note },
    LABELED_AT,
  );
}

function renderChip(overrides: Partial<OwnLabelChipProps> = {}) {
  return renderWithProviders(
    <OwnLabelChip
      subjectType="judge_result"
      subjectId={JUDGE_RESULT_ID}
      stepId={STEP_ID}
      runId={RUN_ID}
      {...overrides}
    />,
  );
}

beforeEach(async () => {
  toastMocks.success.mockClear();
  toastMocks.error.mockClear();
  await signInAs(MEMBER_USER);
});

describe("OwnLabelChip", () => {
  it("shows nothing while the caller has not labeled the subject", async () => {
    const { container, queryClient } = renderChip();

    await waitFor(() =>
      expect(queryClient.getQueryData(qk.labels.own("judge_result", JUDGE_RESULT_ID))).toBeNull(),
    );

    expect(container.querySelector("[data-slot^=own-label]")).toBeNull();
  });

  it("shows the caller's own label with Change and Undo", async () => {
    seedLabel(MEMBER_USER.id, "fail");
    renderChip();

    expect(await screen.findByText("you labeled: fail")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Change your label of this judge result" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Undo your label of this judge result" }),
    ).toBeInTheDocument();
  });

  it("asks the API for the caller's human label of that subject only", async () => {
    seedLabel(MEMBER_USER.id, "pass");
    seedLabel(ADMIN_USER.id, "fail");
    const urls: URL[] = [];
    server.events.on("request:start", ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/labels") {
        urls.push(url);
      }
    });
    renderChip();

    expect(await screen.findByText("you labeled: pass")).toBeInTheDocument();

    server.events.removeAllListeners();
    const url = urls[0];
    expect(url?.searchParams.get("subject_type")).toBe("judge_result");
    expect(url?.searchParams.get("subject_id")).toBe(JUDGE_RESULT_ID);
    expect(url?.searchParams.get("source")).toBe("human");
    expect(url?.searchParams.get("labeled_by")).toBe(MEMBER_USER.id);
  });

  it("opens the label dialog on Change and shows the replacement afterwards", async () => {
    const user = userEvent.setup();
    seedLabel(MEMBER_USER.id, "fail", "first thought");
    renderChip();
    await screen.findByText("you labeled: fail");

    await user.click(
      screen.getByRole("button", { name: "Change your label of this judge result" }),
    );

    const dialog = await screen.findByRole("dialog", { name: "What should the verdict be?" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Fail/ })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Note (optional)" })).toHaveValue("first thought");

    await user.click(screen.getByRole("radio", { name: /^Pass/ }));
    await user.click(screen.getByRole("button", { name: "Save label" }));

    expect(await screen.findByText("you labeled: pass")).toBeInTheDocument();
    expect(toastMocks.success).toHaveBeenCalledWith(
      "Replaced your earlier label of this judge result",
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mockState.stageFour.labels.stats().total_human).toBe(2);
  });

  it("deletes the label on Undo and the chip goes away", async () => {
    const user = userEvent.setup();
    seedLabel(MEMBER_USER.id, "fail");
    const { container } = renderChip();
    await screen.findByText("you labeled: fail");

    await user.click(screen.getByRole("button", { name: "Undo your label of this judge result" }));

    await waitFor(() => expect(container.querySelector("[data-slot^=own-label]")).toBeNull());
    expect(toastMocks.success).toHaveBeenCalledWith("Removed your label of this judge result");
    expect(mockState.stageFour.labels.stats().total_human).toBe(0);
  });

  it("keeps the chip and reports it when the delete fails", async () => {
    const user = userEvent.setup();
    seedLabel(MEMBER_USER.id, "fail");
    server.use(
      http.delete("*/api/v1/labels/:id", () =>
        HttpResponse.json(
          {
            error: {
              code: "forbidden",
              message: "Only your own human labels can be deleted",
              request_id: "req-del",
              details: [],
            },
          },
          { status: 403 },
        ),
      ),
    );
    renderChip();
    await screen.findByText("you labeled: fail");

    await user.click(screen.getByRole("button", { name: "Undo your label of this judge result" }));

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith("Could not remove your label", {
        description: "Only your own human labels can be deleted",
      }),
    );
    expect(screen.getByText("you labeled: fail")).toBeInTheDocument();
  });

  it("does not show another user's label", async () => {
    seedLabel(ADMIN_USER.id, "fail");
    const { container, queryClient } = renderChip();

    await waitFor(() =>
      expect(queryClient.getQueryData(qk.labels.own("judge_result", JUDGE_RESULT_ID))).toBeNull(),
    );

    expect(container.querySelector("[data-slot^=own-label]")).toBeNull();
  });

  it("is read-only for a viewer: the label shows without Change or Undo", async () => {
    await signInAs(VIEWER_USER);
    seedLabel(VIEWER_USER.id, "uncertain");
    renderChip();

    expect(await screen.findByText("you labeled: uncertain")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Change your label/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Undo your label/ })).not.toBeInTheDocument();
  });

  it("says it could not check and retries when the lookup fails", async () => {
    const user = userEvent.setup();
    seedLabel(MEMBER_USER.id, "pass");
    let fail = true;
    server.use(
      http.get("*/api/v1/labels", () => {
        if (fail) {
          return HttpResponse.json(
            {
              error: {
                code: "validation_failed",
                message: "Lookup rejected",
                request_id: "req-lookup",
                details: [],
              },
            },
            { status: 422 },
          );
        }
        return undefined;
      }),
    );
    renderChip();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not check your label of this judge result");
    expect(alert).toHaveTextContent("req-lookup");

    fail = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("you labeled: pass")).toBeInTheDocument();
  });
});
