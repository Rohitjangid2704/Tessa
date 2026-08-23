import { describe, expect, it, vi } from "vitest";
import type { LabelTask } from "@/lib/api/types";
import { render } from "@testing-library/react";
import { screen, userEvent, within } from "@/tests/utils/render";
import {
  AnsweredNote,
  clampConfidence,
  EVIDENCE_PREVIEW_CHARS,
  formatConfidence,
  LabelCard,
  stepHref,
  type LabelCardProps,
} from "./label-card";

const TASK: LabelTask = {
  id: "0198f6f2-4c2a-7d10-9c1e-a40100000001",
  subject_type: "judge_result",
  subject_id: "0198f6f2-4c2a-7d10-9c1e-a40200000001",
  step_id: "0198f6f2-4c2a-7d10-9c1e-a40300000001",
  run_id: "0198f6f2-4c2a-7d10-9c1e-a40400000001",
  question: "Did the assistant refuse the out-of-scope request?",
  machine_value: "fail",
  machine_confidence: 0.724,
  evidence_excerpt: "Sorry, I can only help with your stay.",
  reason: "uncertain",
  created_at: "2026-10-02T09:00:00.000Z",
};

function renderCard(overrides: Partial<LabelCardProps> = {}, task: Partial<LabelTask> = {}) {
  const handlers = { onAnswer: vi.fn(), onSkip: vi.fn(), onUndo: vi.fn() };
  const view = render(
    <LabelCard
      task={{ ...TASK, ...task }}
      machineVisible={false}
      canLabel
      canUndo={false}
      {...handlers}
      {...overrides}
    />,
  );
  return { ...view, ...handlers };
}

describe("confidence helpers", () => {
  it("clamps to 0 to 1 and formats as a percentage", () => {
    expect(clampConfidence(1.4)).toBe(1);
    expect(clampConfidence(-0.2)).toBe(0);
    expect(formatConfidence(0.724)).toBe("72%");
    expect(formatConfidence(1.4)).toBe("100%");
  });

  it("links the step through the run route", () => {
    expect(stepHref(TASK)).toBe(`/runs/${TASK.run_id}/steps/${TASK.step_id}`);
  });
});

describe("LabelCard", () => {
  it("shows the question, the reason chip, the subject and the evidence", () => {
    renderCard();

    expect(screen.getByRole("region", { name: TASK.question })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: TASK.question })).toBeInTheDocument();
    expect(screen.getByText("Uncertain", { selector: "[data-slot=badge]" })).toBeInTheDocument();
    expect(screen.getByText("Judge result")).toBeInTheDocument();
    expect(screen.getByText("The graders could not decide")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Evidence" })).toHaveTextContent(
      "Sorry, I can only help with your stay.",
    );
  });

  it("links to the step in a new tab with noopener", () => {
    renderCard();

    const link = screen.getByRole("link", { name: /Open step/ });
    expect(link).toHaveAttribute("href", `/runs/${TASK.run_id}/steps/${TASK.step_id}`);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link).toHaveAccessibleName("Open step in a new tab");
    expect(link).toHaveAttribute("aria-keyshortcuts", "o");
  });

  it("documents each shortcut on its control", () => {
    renderCard({ canUndo: true });

    expect(screen.getByRole("button", { name: "Pass" })).toHaveAttribute("aria-keyshortcuts", "p");
    expect(screen.getByRole("button", { name: "Fail" })).toHaveAttribute("aria-keyshortcuts", "f");
    expect(screen.getByRole("button", { name: "Uncertain" })).toHaveAttribute(
      "aria-keyshortcuts",
      "u",
    );
    expect(screen.getByRole("button", { name: "Skip" })).toHaveAttribute("aria-keyshortcuts", "s");
    expect(screen.getByRole("button", { name: "Undo last label" })).toHaveAttribute(
      "aria-keyshortcuts",
      "z",
    );
  });

  it("calls the handlers from the buttons", async () => {
    const user = userEvent.setup();
    const { onAnswer, onSkip, onUndo } = renderCard({ canUndo: true });

    await user.click(screen.getByRole("button", { name: "Pass" }));
    await user.click(screen.getByRole("button", { name: "Fail" }));
    await user.click(screen.getByRole("button", { name: "Uncertain" }));
    await user.click(screen.getByRole("button", { name: "Skip" }));
    await user.click(screen.getByRole("button", { name: "Undo last label" }));

    expect(onAnswer.mock.calls).toEqual([["pass"], ["fail"], ["uncertain"]]);
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("disables undo until there is a label to undo", () => {
    renderCard({ canUndo: false });

    expect(screen.getByRole("button", { name: "Undo last label" })).toBeDisabled();
  });

  it("disables the verdict buttons with a reason for a viewer but leaves skip alone", () => {
    renderCard({ canLabel: false, readOnlyReason: "Viewers cannot label." });

    for (const name of ["Pass", "Fail", "Uncertain"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription("Viewers cannot label.");
    }
    expect(screen.getByRole("button", { name: "Skip" })).toBeEnabled();
  });

  describe("blind labeling", () => {
    it("hides the machine value and its confidence until answered", () => {
      renderCard({ machineVisible: false });

      expect(document.querySelector("[data-slot=machine-value-hidden]")).toHaveTextContent(
        "Machine value hidden until you answer",
      );
      expect(screen.queryByText("72% confidence")).not.toBeInTheDocument();
      expect(document.querySelector("[data-slot=machine-value]")).toBeNull();
    });

    it("says audit and disagreement cards are always blind", () => {
      renderCard({ machineVisible: false }, { reason: "audit" });

      expect(document.querySelector("[data-slot=machine-value-hidden]")).toHaveTextContent(
        "Audit and disagreement cards are always blind",
      );
    });

    it("shows the machine value with its confidence when visible", () => {
      renderCard({ machineVisible: true });

      const machine = document.querySelector<HTMLElement>("[data-slot=machine-value]");
      expect(machine).not.toBeNull();
      expect(within(machine as HTMLElement).getByText("Fail")).toBeInTheDocument();
      expect(machine).toHaveTextContent("72% confidence");
    });

    it("clamps a confidence outside 0 to 1", () => {
      renderCard({ machineVisible: true }, { machine_confidence: 1.4 });

      expect(screen.getByText("100% confidence")).toBeInTheDocument();
    });

    it("says so when the machine gave no value", () => {
      renderCard({ machineVisible: true }, { machine_value: null, machine_confidence: null });

      expect(screen.getByText("The machine gave no value for this task.")).toBeInTheDocument();
    });
  });

  describe("evidence", () => {
    const long = `${"a".repeat(EVIDENCE_PREVIEW_CHARS)}${"b".repeat(100)}`;

    it("shows short evidence in full without an expander", () => {
      renderCard();

      expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
    });

    it("truncates long evidence and expands it on request", async () => {
      const user = userEvent.setup();
      renderCard({}, { evidence_excerpt: long });

      const text = document.querySelector("[data-slot=evidence-text]");
      expect(text?.textContent?.endsWith("...")).toBe(true);
      expect(text?.textContent).not.toContain("b");

      const toggle = screen.getByRole("button", { name: "Show all 380 characters" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      await user.click(toggle);

      expect(text?.textContent).toBe(long);
      expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });

    it("collapses again when the next card arrives", async () => {
      const user = userEvent.setup();
      const props: LabelCardProps = {
        task: { ...TASK, evidence_excerpt: long },
        machineVisible: false,
        canLabel: true,
        canUndo: false,
        onAnswer: vi.fn(),
        onSkip: vi.fn(),
        onUndo: vi.fn(),
      };
      const { rerender } = render(<LabelCard {...props} />);
      await user.click(screen.getByRole("button", { name: /Show all/ }));

      rerender(<LabelCard {...props} task={{ ...TASK, id: "other", evidence_excerpt: long }} />);

      expect(screen.getByRole("button", { name: /Show all/ })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });

    it("renders markup in the evidence as plain text", () => {
      const markup = '<img src="x" onerror="alert(1)"><script>alert(2)</script><b>bold</b>';
      renderCard({}, { evidence_excerpt: markup });

      const text = document.querySelector("[data-slot=evidence-text]");
      expect(text?.textContent).toBe(markup);
      expect(text?.querySelector("img, script, b")).toBeNull();
    });
  });
});

describe("AnsweredNote", () => {
  it("reveals the machine value after the answer", () => {
    render(<AnsweredNote answered={{ task: TASK, value: "pass" }} />);

    const note = document.querySelector("[data-slot=answered-note]");
    expect(note).toHaveTextContent("You labeled");
    expect(note).toHaveTextContent("Pass");
    expect(note).toHaveTextContent("The machine said");
    expect(note).toHaveTextContent("Fail");
    expect(note).toHaveTextContent("72% confidence");
  });

  it("says when there was no machine value", () => {
    render(
      <AnsweredNote
        answered={{
          task: { ...TASK, machine_value: null, machine_confidence: null },
          value: "fail",
        }}
      />,
    );

    expect(document.querySelector("[data-slot=answered-note]")).toHaveTextContent(
      "The machine gave no value.",
    );
  });
});
