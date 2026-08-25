import { registerAttemptVerdictResolver, registerStepRecordedHook } from "../simulation/extensions";
import { gradeStep, resolveAttemptVerdict } from "../stage4/grading-rules";
import { mockState } from "../state";

registerStepRecordedHook((context) => {
  const { step } = context;
  const grade = gradeStep(step, mockState.stageTwo.findStep(step.id)?.ok ?? true);
  if (grade === null) {
    return;
  }
  if (grade.probes !== undefined) {
    step.probes = grade.probes;
  }
  if (grade.judge !== undefined) {
    step.judge = grade.judge;
  }
  if (grade.evidence !== undefined) {
    context.updateStep({ evidence: grade.evidence });
  }
  context.updateStep({ verdict: grade.verdict });
  context.emit("step.graded", {
    step_id: step.id,
    run_scenario_id: context.runScenarioId,
    verdict: grade.verdict,
    escalated_to: grade.escalatedTo,
  });
});

registerAttemptVerdictResolver((context) =>
  resolveAttemptVerdict(context.steps, context.defaultVerdict),
);
