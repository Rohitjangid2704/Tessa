import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/lib/api/query-keys";
import { MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import { mockState } from "@/mocks/handlers";
import { stageFourId } from "@/mocks/stage4/label-seed";
import { signInAs } from "@/tests/utils/api-session";
import { renderWithProviders, screen, userEvent, waitFor, within } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import { LabelDialog, type LabelDialogProps } from "./label-dialog";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));

vi.mock("sonner", () => ({ toast: toastMocks }));

const JUDGE_RESULT_ID = stageFourId("subject", 501);
const STEP_ID = stageFourId("step", 501);
const RUN_ID = stageFourId("run", 5);

interface RecordedPost {
  key: string | null;
  body: Record<string, unknown>;
}

function recordPosts(options: { failStepOnce?: boolean } = {}): RecordedPost[] {
  const posts: RecordedPost[] = [];
  let failStep = options.failStepOnce === true;
  server.use(
    http.post("*/api/v1/labels", async ({ request }) => {
      const body = (await request.clone().json()) as Record<string, unknown>;
      posts.push({ key: request.headers.get("Idempotency-Key"), body });
      if (failStep && body.subject_type === "step") {
        failStep = false;
        return HttpResponse.json(
          {
            error: {
              code: "internal_error",
              message: "Internal server error",
              request_id: "req-failed-step",
              details: [],
            },
          },
          { status: 500 },
        );
      }
      return undefined;
    }),
  );
  return posts;
}

function renderDialog(overrides: Partial<LabelDialogProps> = {}) {
  const onOpenChange = vi.fn();
  const view = renderWithProviders(
    <LabelDialog
      subjectType="judge_result"
      subjectId={JUDGE_RESULT_ID}
      stepId={STEP_ID}
      runId={RUN_ID}
      open
      onOpenChange={onOpenChange}
      {...overrides}
    />,
  );
  return { ...view, onOpenChange };
}

const saveButton = () => screen.getByRole("button", { name: /^(Save label|Try again|Retry)/ });

async function ready(): Promise<void> {
  await waitFor(() => expect(saveButton()).toBeEnabled());
}

async function pick(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  await user.click(screen.getByRole("radio", { name: new RegExp(`^${name}`) }));
}

beforeEach(async () => {
  toastMocks.success.mockClear();
  toastMocks.error.mockClear();
  await signInAs(MEMBER_USER);
});

describe("LabelDialog", () => {
  it("asks what the verdict should be with pass, fail and uncertain and an optional note", async () => {
    renderDialog();
    await ready();

    expect(screen.getByRole("dialog", { name: "What should the verdict be?" })).toBeInTheDocument();
    const group = screen.getByRole("radiogroup", { name: "Corrected verdict" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("value")),
    ).toEqual(["pass", "fail", "uncertain"]);
    expect(screen.getByRole("textbox", { name: "Note (optional)" })).toBeInTheDocument();
  });

  it("sends the judge result label and then the step label with their own idempotency keys", async () => {
    const user = userEvent.setup();
    const posts = recordPosts();
    const { onOpenChange, queryClient } = renderDialog();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await ready();

    await pick(user, "Fail");
    await user.type(screen.getByRole("textbox", { name: "Note (optional)" }), "wrong room");
    await user.click(saveButton());

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(posts.map((post) => post.body)).toEqual([
      {
        subject_type: "judge_result",
        subject_id: JUDGE_RESULT_ID,
        value: "fail",
        note: "wrong room",
      },
      { subject_type: "step", subject_id: STEP_ID, value: "fail", note: "wrong room" },
    ]);
    expect(posts[0]?.key).toBeTruthy();
    expect(posts[1]?.key).toBeTruthy();
    expect(posts[0]?.key).not.toBe(posts[1]?.key);
    expect(toastMocks.success).toHaveBeenCalledWith("Saved your label of this judge result");
    expect(toastMocks.success).toHaveBeenCalledWith("Saved your label of this step");

    const invalidated = invalidate.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(invalidated).toContain(JSON.stringify(qk.labels.stats()));
    expect(invalidated).toContain(JSON.stringify(qk.runs.forRun(RUN_ID)));
    expect(invalidated).toContain(JSON.stringify(qk.runs.lists()));
    expect(invalidated).toContain(JSON.stringify(qk.runScenarios.all()));
    expect(invalidated).toContain(JSON.stringify(qk.steps.detail(STEP_ID)));
    expect(queryClient.getQueryData(qk.labels.own("step", STEP_ID))).toMatchObject({
      value: "fail",
    });
  });

  it("sends only the judge result label when the step verdict is left out", async () => {
    const user = userEvent.setup();
    const posts = recordPosts();
    const { onOpenChange, queryClient } = renderDialog();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await ready();

    await pick(user, "Pass");
    await user.click(screen.getByRole("checkbox", { name: /Also set the verdict of the step/ }));
    await user.click(saveButton());

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(posts.map((post) => post.body.subject_type)).toEqual(["judge_result"]);
    const invalidated = invalidate.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(invalidated).toContain(JSON.stringify(qk.labels.stats()));
    expect(invalidated).not.toContain(JSON.stringify(qk.runScenarios.all()));
  });

  it("sends one step label and offers no step checkbox when the subject is the step", async () => {
    const user = userEvent.setup();
    const posts = recordPosts();
    const { onOpenChange } = renderDialog({ subjectType: "step", subjectId: STEP_ID });
    await ready();

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await pick(user, "Uncertain");
    await user.click(saveButton());

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(posts.map((post) => post.body)).toEqual([
      { subject_type: "step", subject_id: STEP_ID, value: "uncertain" },
    ]);
  });

  it("sends one label for a probe result without a step id", async () => {
    const user = userEvent.setup();
    const posts = recordPosts();
    const { onOpenChange } = renderDialog({ subjectType: "probe_result", stepId: undefined });
    await ready();

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await pick(user, "Fail");
    await user.click(saveButton());

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(posts.map((post) => post.body.subject_type)).toEqual(["probe_result"]);
  });

  it("keeps the dialog open after a partial failure and retries only the failed call with its key", async () => {
    const user = userEvent.setup();
    const posts = recordPosts({ failStepOnce: true });
    const { onOpenChange } = renderDialog();
    await ready();

    await pick(user, "Fail");
    await user.click(saveButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The label on the judge result is saved, but the step label was not",
    );
    expect(alert).toHaveTextContent("req-failed-step");
    expect(onOpenChange).not.toHaveBeenCalled();
    const requests = screen.getByRole("list", { name: "Label requests" });
    expect(within(requests).getByText("Label on the judge result: saved")).toBeInTheDocument();
    expect(within(requests).getByText("Label on the step verdict: failed")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Fail/ })).toBeDisabled();
    expect(posts).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Retry step label" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(posts).toHaveLength(3);
    expect(posts.map((post) => post.body.subject_type)).toEqual(["judge_result", "step", "step"]);
    expect(posts[2]?.key).toBe(posts[1]?.key);
    expect(posts[2]?.key).not.toBe(posts[0]?.key);
    expect(toastMocks.success).toHaveBeenCalledTimes(2);
  });

  it("retries the first call alone when it failed, as a plain try again", async () => {
    const user = userEvent.setup();
    const posts: RecordedPost[] = [];
    let failures = 1;
    server.use(
      http.post("*/api/v1/labels", async ({ request }) => {
        posts.push({
          key: request.headers.get("Idempotency-Key"),
          body: (await request.clone().json()) as Record<string, unknown>,
        });
        if (failures > 0) {
          failures -= 1;
          return HttpResponse.json(
            {
              error: { code: "internal_error", message: "Down", request_id: "req-1", details: [] },
            },
            { status: 500 },
          );
        }
        return undefined;
      }),
    );
    const { onOpenChange } = renderDialog();
    await ready();

    await pick(user, "Pass");
    await user.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Your label was not saved.");

    await user.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(posts.map((post) => post.body.subject_type)).toEqual([
      "judge_result",
      "judge_result",
      "step",
    ]);
    expect(posts[1]?.key).toBe(posts[0]?.key);
  });

  it("toasts that an earlier label was replaced when the API answers 200", async () => {
    const user = userEvent.setup();
    mockState.stageFour.labels.saveHuman(
      MEMBER_USER.id,
      { subject_type: "judge_result", subject_id: JUDGE_RESULT_ID, value: "pass", note: null },
      "2026-10-03T08:00:00.000Z",
    );
    const { onOpenChange } = renderDialog();
    await ready();

    await pick(user, "Fail");
    await user.click(saveButton());

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toastMocks.success).toHaveBeenCalledWith(
      "Replaced your earlier label of this judge result",
    );
    expect(toastMocks.success).toHaveBeenCalledWith("Saved your label of this step");
  });

  it("asks for a verdict before sending anything", async () => {
    const user = userEvent.setup();
    const posts = recordPosts();
    renderDialog();
    await ready();

    await user.click(saveButton());

    expect(await screen.findByText("Choose what the verdict should be")).toBeInTheDocument();
    expect(posts).toHaveLength(0);
  });

  it("shows a server validation message under the note", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/api/v1/labels", () =>
        HttpResponse.json(
          {
            error: {
              code: "validation_failed",
              message: "Request validation failed",
              request_id: "req-422",
              details: [
                { loc: ["body", "note"], code: "string_too_long", message: "Note is too long" },
              ],
            },
          },
          { status: 422 },
        ),
      ),
    );
    renderDialog({ subjectType: "step", subjectId: STEP_ID });
    await ready();

    await pick(user, "Fail");
    await user.click(saveButton());

    expect(await screen.findByText("Note is too long")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Note (optional)" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("starts from the given verdict and note", async () => {
    renderDialog({ initialValue: "fail", initialNote: "earlier note" });
    await ready();

    expect(screen.getByRole("radio", { name: /^Fail/ })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Note (optional)" })).toHaveValue("earlier note");
  });

  it("does not close while a request is in flight", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/api/v1/labels", async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return undefined;
      }),
    );
    const { onOpenChange } = renderDialog({ subjectType: "step", subjectId: STEP_ID });
    await ready();

    await pick(user, "Pass");
    await user.click(saveButton());
    expect(await screen.findByRole("button", { name: "Saving" })).toBeDisabled();
    await user.keyboard("{Escape}");

    expect(onOpenChange).not.toHaveBeenCalled();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("explains that a viewer cannot label and keeps the form disabled", async () => {
    await signInAs(VIEWER_USER);
    renderDialog();

    expect(await screen.findByText(/You have the viewer role/)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole("radio", { name: /^Pass/ })).toBeDisabled();
  });
});
