import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/lib/api/query-keys";
import { MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import { mockState } from "@/mocks/handlers";
import { STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { LABEL_TASK_COUNT, stageFourId } from "@/mocks/stage4/label-seed";
import { resetLocation, trackHistory } from "@/tests/utils/fake-navigation";
import { signInAs } from "@/tests/utils/api-session";
import { renderWithProviders, screen, userEvent, waitFor, within } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import { resetRevealMachineValue, REVEAL_MACHINE_STORAGE_KEY } from "../blind-mode";
import { LabelQueue } from "./label-queue";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

vi.mock("next/navigation", async () => await import("@/tests/utils/fake-navigation"));

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));

vi.mock("sonner", () => ({ toast: toastMocks }));

function taskId(index: number): string {
  return stageFourId("task", index);
}

function currentTaskId(): string | null {
  return document.querySelector("[data-slot=label-card]")?.getAttribute("data-task-id") ?? null;
}

function countText(): string {
  return document.querySelector("[data-slot=label-progress-count]")?.textContent ?? "";
}

function liveRegionText(): string {
  return document.querySelector("[data-slot=label-live-region]")?.textContent ?? "";
}

const passButton = () => screen.getByRole("button", { name: "Pass" });

async function loaded(): Promise<void> {
  await waitFor(() => expect(currentTaskId()).not.toBeNull());
  await waitFor(() => expect(passButton()).toBeEnabled());
  await waitFor(() => expect(countText()).not.toBe(""));
}

async function settled(): Promise<void> {
  await waitFor(() => expect(document.querySelector("[data-slot=saving]")).toBeNull());
}

function recordRequests(): URL[] {
  const urls: URL[] = [];
  server.events.on("request:start", ({ request }) => {
    urls.push(new URL(request.url));
  });
  return urls;
}

function errorBody(status: number, code: string, message: string, requestId = "req-queue") {
  return HttpResponse.json(
    { error: { code, message, request_id: requestId, details: [] } },
    { status },
  );
}

beforeEach(async () => {
  resetLocation("/labels");
  window.localStorage.clear();
  resetRevealMachineValue();
  toastMocks.success.mockClear();
  toastMocks.error.mockClear();
  await signInAs(MEMBER_USER);
});

afterEach(() => {
  server.events.removeAllListeners();
  window.localStorage.clear();
  resetRevealMachineValue();
  vi.restoreAllMocks();
});

describe("LabelQueue states", () => {
  it("shows a loading state and then the first card with the count and the progress", async () => {
    renderWithProviders(<LabelQueue />);

    expect(
      screen.getAllByRole("status").some((node) => /Loading/.test(node.textContent ?? "")),
    ).toBe(true);
    await loaded();

    expect(currentTaskId()).toBe(taskId(0));
    expect(document.querySelector("[data-slot=queue-count]")).toHaveTextContent(
      `${LABEL_TASK_COUNT} left to review`,
    );
    expect(countText()).toContain("0 of 50");
  });

  it("says there is nothing to review when the queue is empty", async () => {
    mockState.stageFour.reset("empty");
    renderWithProviders(<LabelQueue />);

    expect(await screen.findByRole("heading", { name: "Nothing to review" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
  });

  it("explains a failed load with the request id and loads again on retry", async () => {
    const user = userEvent.setup();
    let fail = true;
    server.use(
      http.get("*/api/v1/labels/queue", () => {
        if (fail) {
          return errorBody(503, "dependency_unavailable", "Queue offline", "req-queue-down");
        }
        return undefined;
      }),
    );
    renderWithProviders(<LabelQueue />);

    const alert = await screen.findByRole("heading", { name: "Could not load the review queue" });
    expect(alert.closest("section")).toHaveTextContent("req-queue-down");

    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await loaded();
    expect(currentTaskId()).toBe(taskId(0));
  }, 15_000);

  it("says no tasks match when the filters leave nothing and clears them", async () => {
    const user = userEvent.setup();
    resetLocation(`/labels?target_id=${STAGE_ONE_IDS.liveShop}`);
    const history = trackHistory();
    renderWithProviders(<LabelQueue />);

    expect(
      await screen.findByRole("heading", { name: "No tasks match these filters" }),
    ).toBeInTheDocument();
    const emptyState = screen
      .getByRole("heading", { name: "No tasks match these filters" })
      .closest("section");
    await user.click(
      within(emptyState as HTMLElement).getByRole("button", { name: "Clear filters" }),
    );

    await loaded();
    expect(history.calls.replace.at(-1)).toBe("/labels");
    history.restore();
  });
});

describe("LabelQueue filters in the URL", () => {
  it("reads reason and subject filters from the URL and narrows the queue", async () => {
    resetLocation("/labels?reason=audit&subject_type=probe_result&subject_type=step");
    const requests = recordRequests();
    renderWithProviders(<LabelQueue />);
    await loaded();

    const queueRequest = requests.find((url) => url.pathname === "/api/v1/labels/queue");
    expect(queueRequest?.searchParams.getAll("reason")).toEqual(["audit"]);
    expect(queueRequest?.searchParams.getAll("subject_type")).toEqual(["probe_result", "step"]);
    expect(document.querySelector("[data-reason]")?.getAttribute("data-reason")).toBe("audit");
  });

  it("writes a chosen reason to the URL with replaceState and reloads the queue", async () => {
    const user = userEvent.setup();
    const history = trackHistory();
    renderWithProviders(<LabelQueue />);
    await loaded();

    await user.click(screen.getByRole("button", { name: /^Reason: any/ }));
    await user.click(await screen.findByRole("checkbox", { name: "Audit" }));

    await waitFor(() => expect(history.calls.replace.at(-1)).toBe("/labels?reason=audit"));
    await waitFor(() =>
      expect(document.querySelector("[data-slot=label-card]")?.getAttribute("data-reason")).toBe(
        "audit",
      ),
    );
    expect(history.calls.push).toEqual([]);
    expect(document.querySelector("[data-slot=queue-count]")).toHaveTextContent(
      "10 left to review",
    );
    history.restore();
  });
});

describe("LabelQueue labeling", () => {
  it("advances to the next card at once and posts the label for the task's own subject", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/api/v1/labels", async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return undefined;
      }),
    );
    const requests = recordRequests();
    renderWithProviders(<LabelQueue />);
    await loaded();
    const first = mockState.stageFour.labels.tasks[0]?.task;

    await user.click(passButton());

    expect(currentTaskId()).toBe(taskId(1));
    expect(document.querySelector("[data-slot=saving]")).toHaveTextContent("Saving 1 label");
    expect(liveRegionText()).toBe("labeled pass, 1 of 50");
    expect(countText()).toContain("1 of 50");
    await settled();

    const post = requests.find((url) => url.pathname === "/api/v1/labels");
    expect(post).toBeDefined();
    const labels = mockState.stageFour.labels.humanRecords();
    expect(labels).toHaveLength(1);
    expect(labels[0]?.label).toMatchObject({
      subject_type: first?.subject_type,
      subject_id: first?.subject_id,
      value: "pass",
      labeled_by: MEMBER_USER.id,
    });
    expect(countText()).toContain("1 of 50");
  });

  it("labels ten tasks with the keyboard alone and the progress follows", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LabelQueue />);
    await loaded();

    for (const key of ["p", "f", "u", "p", "f", "u", "p", "f", "u", "p"]) {
      await user.keyboard(key);
    }

    await waitFor(() => expect(mockState.stageFour.labels.humanRecords()).toHaveLength(10));
    expect(currentTaskId()).toBe(taskId(10));
    expect(mockState.stageFour.labels.humanRecords().map((record) => record.label.value)).toEqual([
      "pass",
      "fail",
      "uncertain",
      "pass",
      "fail",
      "uncertain",
      "pass",
      "fail",
      "uncertain",
      "pass",
    ]);
    await settled();
    await waitFor(() => expect(countText()).toContain("10 of 50"));
    expect(liveRegionText()).toBe("labeled pass, 10 of 50");
    expect(document.querySelector("[data-slot=queue-count]")).toHaveTextContent(
      "50 left to review",
    );
  }, 20_000);

  it("reveals the machine value after answering", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LabelQueue />);
    await loaded();
    expect(document.querySelector("[data-slot=machine-value]")).toBeNull();

    await user.keyboard("p");

    await waitFor(() =>
      expect(document.querySelector("[data-slot=answered-note]")).toHaveTextContent(
        "You labeled Pass The machine said Uncertain 40% confidence",
      ),
    );
  });

  it("skips a card to the end of the queue with s", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LabelQueue />);
    await loaded();

    await user.keyboard("s");

    expect(currentTaskId()).toBe(taskId(1));
    expect(document.querySelector("[data-slot=queue-count]")).toHaveTextContent("1 skipped");
    expect(liveRegionText()).toContain("skipped");
    expect(mockState.stageFour.labels.humanRecords()).toHaveLength(0);
  });

  it("opens the step in a new tab with o", async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderWithProviders(<LabelQueue />);
    await loaded();

    await user.keyboard("o");

    expect(open).toHaveBeenCalledWith(
      `/runs/${stageFourId("run", 0)}/steps/${stageFourId("step", 0)}`,
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("undoes the last label with z: the card comes back and the label is deleted", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LabelQueue />);
    await loaded();

    await user.keyboard("p");
    await settled();
    expect(currentTaskId()).toBe(taskId(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Undo last label" })).toBeEnabled(),
    );

    await user.keyboard("z");

    expect(currentTaskId()).toBe(taskId(0));
    await waitFor(() => expect(mockState.stageFour.labels.humanRecords()).toHaveLength(0));
    await waitFor(() => expect(countText()).toContain("0 of 50"));
    expect(liveRegionText()).toBe("undid your last label, the card is back");
    expect(document.querySelector("[data-slot=answered-note]")).toBeNull();
  });

  it("undoes only one step: a second z does nothing", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LabelQueue />);
    await loaded();
    await user.keyboard("p");
    await settled();
    await user.keyboard("p");
    await settled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Undo last label" })).toBeEnabled(),
    );

    await user.keyboard("z");
    await user.keyboard("z");

    expect(currentTaskId()).toBe(taskId(1));
    await waitFor(() => expect(mockState.stageFour.labels.humanRecords()).toHaveLength(1));
  });

  it("invalidates the run counters when a step label is undone", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<LabelQueue />);
    await loaded();
    await user.keyboard("s");
    await user.keyboard("s");
    expect(currentTaskId()).toBe(taskId(2));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await user.keyboard("p");
    await settled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Undo last label" })).toBeEnabled(),
    );
    invalidate.mockClear();
    await user.keyboard("z");

    await waitFor(() => {
      const keys = invalidate.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
      expect(keys).toContain(JSON.stringify(qk.runScenarios.all()));
      expect(keys).toContain(JSON.stringify(qk.runs.forRun(stageFourId("run", 2))));
    });
  });

  it("rolls back a failed label: the card returns, the user is told and focus stays on the card", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/api/v1/labels", () =>
        errorBody(500, "internal_error", "Internal server error", "req-label-500"),
      ),
    );
    renderWithProviders(<LabelQueue />);
    await loaded();

    await user.keyboard("p");

    const alert = await screen.findByText(/The card is back/);
    expect(alert.closest("[role=alert]")).toHaveTextContent("req-label-500");
    expect(currentTaskId()).toBe(taskId(0));
    expect(toastMocks.error).toHaveBeenCalledWith("Could not save your label", {
      description: "Internal server error",
    });
    expect(document.activeElement).toBe(document.querySelector("[data-slot=card-frame]"));
    expect(liveRegionText()).toBe("could not save the label, the card is back");
    await waitFor(() => expect(countText()).toContain("0 of 50"));
    expect(mockState.stageFour.labels.humanRecords()).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/The card is back/)).not.toBeInTheDocument();
  });

  it("lets the answer be tried again after a rollback", async () => {
    const user = userEvent.setup();
    let fail = true;
    server.use(
      http.post("*/api/v1/labels", () => {
        if (fail) {
          return errorBody(500, "internal_error", "Internal server error");
        }
        return undefined;
      }),
    );
    renderWithProviders(<LabelQueue />);
    await loaded();
    await user.keyboard("p");
    await screen.findByText(/The card is back/);

    fail = false;
    await user.keyboard("p");

    await waitFor(() => expect(mockState.stageFour.labels.humanRecords()).toHaveLength(1));
    expect(currentTaskId()).toBe(taskId(1));
    expect(screen.queryByText(/The card is back/)).not.toBeInTheDocument();
  });

  it("restores the card and says so when the undo fails", async () => {
    const user = userEvent.setup();
    server.use(
      http.delete("*/api/v1/labels/:id", () =>
        errorBody(500, "internal_error", "Internal server error"),
      ),
    );
    renderWithProviders(<LabelQueue />);
    await loaded();
    await user.keyboard("p");
    await settled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Undo last label" })).toBeEnabled(),
    );

    await user.keyboard("z");

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith("Could not undo your label", {
        description: "Internal server error",
      }),
    );
    await waitFor(() => expect(currentTaskId()).toBe(taskId(1)));
    expect(mockState.stageFour.labels.humanRecords()).toHaveLength(1);
  });

  it("prefetches the next page when five cards remain", async () => {
    const user = userEvent.setup();
    const requests = recordRequests();
    renderWithProviders(<LabelQueue />);
    await loaded();
    const queuePages = () =>
      requests.filter(
        (url) => url.pathname === "/api/v1/labels/queue" && url.searchParams.has("cursor"),
      );
    expect(queuePages()).toHaveLength(0);

    for (let index = 0; index < 14; index += 1) {
      await user.keyboard("p");
    }
    expect(queuePages()).toHaveLength(0);
    await user.keyboard("p");

    await waitFor(() => expect(queuePages()).toHaveLength(1));
    for (let index = 0; index < 10; index += 1) {
      await user.keyboard("p");
    }
    expect(currentTaskId()).toBe(taskId(25));
    await waitFor(() => expect(mockState.stageFour.labels.humanRecords()).toHaveLength(25));
  }, 30_000);

  it("shows the end of the queue after the last card and checks for new tasks", async () => {
    const user = userEvent.setup();
    const tasks = mockState.stageFour.labels.tasks.slice(0, 2).map((entry) => entry.task);
    server.use(
      http.get("*/api/v1/labels/queue", () =>
        HttpResponse.json({ items: tasks, next_cursor: null, total: 2 }),
      ),
    );
    const requests = recordRequests();
    renderWithProviders(<LabelQueue />);
    await loaded();

    await user.keyboard("p");
    await user.keyboard("f");

    expect(
      await screen.findByRole("heading", { name: "You reached the end of the queue" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/You labeled 2 tasks in this session/)).toBeInTheDocument();

    const before = requests.filter((url) => url.pathname === "/api/v1/labels/queue").length;
    await user.click(screen.getByRole("button", { name: "Check for new tasks" }));

    await waitFor(() =>
      expect(
        requests.filter((url) => url.pathname === "/api/v1/labels/queue").length,
      ).toBeGreaterThan(before),
    );
  });

  it("tells the user when the next page cannot load and retries", async () => {
    const user = userEvent.setup();
    const [only] = mockState.stageFour.labels.tasks.map((entry) => entry.task);
    let failNextPage = true;
    server.use(
      http.get("*/api/v1/labels/queue", ({ request }) => {
        if (new URL(request.url).searchParams.has("cursor")) {
          if (failNextPage) {
            return errorBody(500, "internal_error", "Page failed", "req-page");
          }
          return HttpResponse.json({ items: [], next_cursor: null, total: 1 });
        }
        return HttpResponse.json({ items: [only], next_cursor: "more", total: 1 });
      }),
    );
    renderWithProviders(<LabelQueue />);
    await loaded();

    await user.keyboard("p");

    expect(
      await screen.findByRole("heading", { name: "Could not load more cards" }),
    ).toBeInTheDocument();
    failNextPage = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("heading", { name: "You reached the end of the queue" }),
    ).toBeInTheDocument();
  }, 15_000);

  it("shows 50 of 50 reached when the last two labels come in", async () => {
    const user = userEvent.setup();
    mockState.stageFour.reset("almost_done");
    renderWithProviders(<LabelQueue />);
    await loaded();
    expect(countText()).toContain("48 of 50");
    expect(document.querySelector("[data-slot=label-goal-reached]")).toBeNull();

    await user.keyboard("p");
    await user.keyboard("f");

    await waitFor(() =>
      expect(document.querySelector("[data-slot=label-goal-reached]")).toHaveTextContent(
        "50 of 50 reached",
      ),
    );
    expect(countText()).toContain("50 of 50");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    expect(currentTaskId()).toBe(taskId(2));
  });
});

describe("LabelQueue blind labeling", () => {
  it("hides the machine value by default and shows it when the person turns the toggle on", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LabelQueue />);
    await loaded();
    expect(document.querySelector("[data-slot=machine-value-hidden]")).not.toBeNull();

    await user.click(screen.getByRole("switch", { name: "Show machine value before I answer" }));

    expect(document.querySelector("[data-slot=machine-value]")).toHaveTextContent("Uncertain");
    expect(document.querySelector("[data-slot=machine-value]")).toHaveTextContent("40% confidence");
    expect(window.localStorage.getItem(REVEAL_MACHINE_STORAGE_KEY)).toBe("yes");
  });

  it("starts revealed when the person already turned the toggle on", async () => {
    window.localStorage.setItem(REVEAL_MACHINE_STORAGE_KEY, "yes");
    renderWithProviders(<LabelQueue />);
    await loaded();

    expect(
      screen.getByRole("switch", { name: "Show machine value before I answer" }),
    ).toBeChecked();
    expect(document.querySelector("[data-slot=machine-value]")).not.toBeNull();
  });

  it("keeps audit cards blind even with the toggle on", async () => {
    window.localStorage.setItem(REVEAL_MACHINE_STORAGE_KEY, "yes");
    resetLocation("/labels?reason=audit");
    renderWithProviders(<LabelQueue />);
    await loaded();

    expect(document.querySelector("[data-reason]")?.getAttribute("data-reason")).toBe("audit");
    expect(document.querySelector("[data-slot=machine-value]")).toBeNull();
    expect(document.querySelector("[data-slot=machine-value-hidden]")).toHaveTextContent(
      "Audit and disagreement cards are always blind",
    );
  });

  it("keeps disagreement cards blind even with the toggle on", async () => {
    window.localStorage.setItem(REVEAL_MACHINE_STORAGE_KEY, "yes");
    resetLocation("/labels?reason=disagreement");
    renderWithProviders(<LabelQueue />);
    await loaded();

    expect(document.querySelector("[data-slot=machine-value]")).toBeNull();
  });
});

describe("LabelQueue help overlay", () => {
  it("opens with ? and closes with Escape", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LabelQueue />);
    await loaded();

    await user.keyboard("?");

    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(dialog).getByText("Label the card pass")).toBeInTheDocument();
    expect(
      within(dialog).getByText("Undo your last label and bring the card back"),
    ).toBeInTheDocument();

    await user.keyboard("p");
    expect(mockState.stageFour.labels.humanRecords()).toHaveLength(0);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("opens from the Shortcuts button", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LabelQueue />);
    await loaded();

    await user.click(screen.getByRole("button", { name: "Shortcuts" }));

    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });
});

describe("LabelQueue as a viewer", () => {
  beforeEach(async () => {
    await signInAs(VIEWER_USER);
  });

  it("shows the stats and the card read-only and sends nothing", async () => {
    const user = userEvent.setup();
    const requests = recordRequests();
    renderWithProviders(<LabelQueue />);

    expect(await screen.findByText(/You have the viewer role/)).toBeInTheDocument();
    await waitFor(() => expect(currentTaskId()).toBe(taskId(0)));
    await waitFor(() => expect(countText()).toContain("0 of 50"));
    for (const name of ["Pass", "Fail", "Uncertain", "Undo last label"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }

    await user.keyboard("p");
    await user.keyboard("z");

    expect(currentTaskId()).toBe(taskId(0));
    expect(requests.filter((url) => url.pathname === "/api/v1/labels")).toHaveLength(0);
    expect(mockState.stageFour.labels.humanRecords()).toHaveLength(0);
  });

  it("can still skip through the cards and open the help", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LabelQueue />);
    await screen.findByText(/You have the viewer role/);
    await waitFor(() => expect(currentTaskId()).toBe(taskId(0)));

    await user.keyboard("s");
    expect(currentTaskId()).toBe(taskId(1));

    await user.keyboard("?");
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });
});
