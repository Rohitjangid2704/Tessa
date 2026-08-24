import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/errors";
import { MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import { signInAs } from "@/tests/utils/api-session";
import { cachedRun, makeRun, RUN_ID, serveRun } from "@/tests/utils/run-detail-fixtures";
import { renderWithStream } from "@/tests/utils/run-stream-harness";
import { screen, userEvent, waitFor, within } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const { CancelRunButton, describeCancelError } = await import("./cancel-run-button");

beforeEach(async () => {
  await signInAs(MEMBER_USER);
});

function renderButton(run = makeRun()) {
  return renderWithStream(<CancelRunButton run={run} />);
}

describe("CancelRunButton flow", () => {
  it("asks for confirmation and sends nothing until the user confirms", async () => {
    const { requests } = serveRun();
    renderButton();

    await userEvent.click(await screen.findByRole("button", { name: "Cancel run" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Cancel this run?" });
    expect(requests.cancel).toBe(0);

    await userEvent.click(within(dialog).getByRole("button", { name: "Keep running" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(requests.cancel).toBe(0);
  });

  it("posts the cancel and writes the returned run into the cache", async () => {
    const { requests, state } = serveRun();
    state.cancelResponse = makeRun({ status: "canceling", event_head_seq: 12 });
    const { queryClient } = renderButton();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await userEvent.click(await screen.findByRole("button", { name: "Cancel run" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel run" }));

    await waitFor(() => expect(cachedRun(queryClient)?.status).toBe("canceling"));
    expect(requests.cancel).toBe(1);
    expect(cachedRun(queryClient)?.event_head_seq).toBe(12);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["runs", "list"] });
  });

  it("sends no idempotency key because cancel is not a creating call", async () => {
    let header: string | null = "unset";
    server.use(
      http.post("*/api/v1/runs/:run_id/cancel", ({ request }) => {
        header = request.headers.get("idempotency-key");
        return HttpResponse.json(makeRun({ status: "canceling" }), { status: 202 });
      }),
    );
    renderButton();

    await userEvent.click(await screen.findByRole("button", { name: "Cancel run" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel run" }),
    );

    await waitFor(() => expect(header).toBeNull());
  });

  it("on 409 run_not_cancelable explains, refetches the run and keeps the page usable", async () => {
    const { requests, state } = serveRun();
    state.cancelResponse = { status: 409, code: "run_not_cancelable" };
    const { queryClient } = renderButton();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await userEvent.click(await screen.findByRole("button", { name: "Cancel run" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel run" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This run can no longer be canceled",
    );
    expect(requests.cancel).toBe(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["runs", RUN_ID, "detail"] });
    expect(screen.getByRole("button", { name: "Cancel run" })).toBeEnabled();
  });

  it("shows the API message for any other failure", async () => {
    const { state } = serveRun();
    state.cancelResponse = { status: 500, code: "internal_error" };
    renderButton();

    await userEvent.click(await screen.findByRole("button", { name: "Cancel run" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel run" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/internal_error|server/i);
  });
});

describe("CancelRunButton visibility", () => {
  it.each(["queued", "planning", "seeding", "running"] as const)(
    "is offered while %s",
    async (status) => {
      renderButton(makeRun({ status }));

      expect(await screen.findByRole("button", { name: "Cancel run" })).toBeInTheDocument();
    },
  );

  it.each(["completed", "failed", "canceled", "budget_exceeded"] as const)(
    "is gone once the run is %s",
    async (status) => {
      renderButton(makeRun({ status }));

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByRole("button")).toBeNull();
    },
  );

  it("shows a disabled Canceling button while the workflow stops", async () => {
    renderButton(makeRun({ status: "canceling" }));

    expect(await screen.findByRole("button", { name: "Canceling" })).toBeDisabled();
  });

  it("is hidden from a viewer", async () => {
    await signInAs(VIEWER_USER);
    renderButton();

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("describeCancelError", () => {
  it("words the cases the user can act on", () => {
    expect(
      describeCancelError(new ApiError({ status: 409, code: "run_not_cancelable", message: "x" })),
    ).toContain("can no longer be canceled");
    expect(
      describeCancelError(new ApiError({ status: 403, code: "forbidden", message: "x" })),
    ).toBe("You do not have permission to cancel runs.");
    expect(describeCancelError(new Error("boom"))).toBeTruthy();
  });
});
