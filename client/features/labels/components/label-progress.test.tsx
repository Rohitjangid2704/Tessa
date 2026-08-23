import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LabelStats } from "@/lib/api/types";
import { MEMBER_USER } from "@/mocks/factories/users";
import { mockState } from "@/mocks/handlers";
import { stageFourId } from "@/mocks/stage4/label-seed";
import { signInAs } from "@/tests/utils/api-session";
import { render } from "@testing-library/react";
import { renderWithProviders, screen, userEvent } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import {
  describeAgreement,
  LabelProgress,
  ProgressSummary,
  progressPercent,
} from "./label-progress";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

function stats(overrides: Partial<LabelStats> = {}): LabelStats {
  return {
    total_human: 12,
    total_weak: 3,
    by_subject_type: { step: 12 },
    agreement_with_machine: 0.75,
    ...overrides,
  };
}

beforeEach(async () => {
  await signInAs(MEMBER_USER);
});

describe("progressPercent and describeAgreement", () => {
  it("rounds to a percentage and never goes over a hundred or below zero", () => {
    expect(progressPercent(0)).toBe(0);
    expect(progressPercent(12)).toBe(24);
    expect(progressPercent(50)).toBe(100);
    expect(progressPercent(80)).toBe(100);
    expect(progressPercent(-3)).toBe(0);
  });

  it("words the agreement, or says there is none yet", () => {
    expect(describeAgreement(0.753)).toBe(
      "75% agreement with the machine, across every human label",
    );
    expect(describeAgreement(0)).toBe("0% agreement with the machine, across every human label");
    expect(describeAgreement(1.4)).toBe(
      "100% agreement with the machine, across every human label",
    );
    expect(describeAgreement(null)).toBe(
      "No agreement figure yet. It appears after the first human label.",
    );
  });
});

describe("ProgressSummary", () => {
  it("shows total_human of 50 on a progress bar and the agreement", () => {
    render(<ProgressSummary stats={stats()} />);

    expect(screen.getByRole("heading", { name: "Labels toward the first 50" })).toBeInTheDocument();
    expect(document.querySelector("[data-slot=label-progress-count]")).toHaveTextContent(
      "12 of 50",
    );
    const bar = screen.getByRole("progressbar", { name: "Labels toward the goal" });
    expect(bar).toHaveAttribute("aria-valuenow", "24");
    expect(bar).toHaveAttribute("aria-valuetext", "12 of 50 labels");
    expect(screen.getByText(/75% agreement with the machine/)).toBeInTheDocument();
    expect(document.querySelector("[data-slot=label-goal-reached]")).toBeNull();
  });

  it("says there is no agreement yet before the first label", () => {
    render(<ProgressSummary stats={stats({ total_human: 0, agreement_with_machine: null })} />);

    expect(document.querySelector("[data-slot=label-progress-count]")).toHaveTextContent("0 of 50");
    expect(screen.getByText(/No agreement figure yet/)).toBeInTheDocument();
  });

  it("marks 50 of 50 as reached", () => {
    render(<ProgressSummary stats={stats({ total_human: 50 })} />);

    expect(document.querySelector("[data-slot=label-progress-count]")).toHaveTextContent(
      "50 of 50",
    );
    expect(screen.getByText(/50 of 50 reached/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });

  it("caps the count at the goal and mentions the real total beyond it", () => {
    render(<ProgressSummary stats={stats({ total_human: 62 })} />);

    expect(document.querySelector("[data-slot=label-progress-count]")).toHaveTextContent(
      "50 of 50",
    );
    expect(screen.getByText(/62 labels in all/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });
});

describe("LabelProgress", () => {
  it("loads the stats from the API", async () => {
    mockState.stageFour.reset("almost_done");
    renderWithProviders(<LabelProgress />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading label progress");
    expect(
      await screen.findByRole("heading", { name: "Labels toward the first 50" }),
    ).toBeInTheDocument();
    expect(document.querySelector("[data-slot=label-progress-count]")).toHaveTextContent(
      "48 of 50",
    );
    expect(screen.getByText(/75% agreement with the machine/)).toBeInTheDocument();
  });

  it("moves with the stats the server holds", async () => {
    mockState.stageFour.reset("default");
    for (let index = 0; index < 3; index += 1) {
      mockState.stageFour.labels.saveHuman(
        MEMBER_USER.id,
        {
          subject_type: "step",
          subject_id: stageFourId("step", 800 + index),
          value: "pass",
          note: null,
        },
        "2026-10-03T08:00:00.000Z",
      );
    }
    renderWithProviders(<LabelProgress />);

    await screen.findByRole("heading", { name: "Labels toward the first 50" });
    expect(document.querySelector("[data-slot=label-progress-count]")).toHaveTextContent("3 of 50");
  });

  it("explains an error with the request id and retries", async () => {
    const user = userEvent.setup();
    let fail = true;
    server.use(
      http.get("*/api/v1/labels/stats", () => {
        if (fail) {
          return HttpResponse.json(
            {
              error: {
                code: "forbidden",
                message: "Stats are off",
                request_id: "req-stats",
                details: [],
              },
            },
            { status: 403 },
          );
        }
        return undefined;
      }),
    );
    renderWithProviders(<LabelProgress />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Could not load label progress. Stats are off (request req-stats)",
    );

    fail = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(
      await screen.findByRole("heading", { name: "Labels toward the first 50" }),
    ).toBeInTheDocument();
  });
});
