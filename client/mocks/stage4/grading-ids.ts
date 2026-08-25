import { GRADING_GROUPS } from "../fixtures/steps-grading";
import { stepFixtureGroups } from "../fixtures/steps";
import { fixtureRunScenarioId, fixtureStepId, STAGE_TWO_IDS } from "../stage2/seed-ids";

export const GRADING_STEP_IDS = {
  tier0Fail: fixtureStepId(GRADING_GROUPS.tier0, "tier0Fail"),
  notGraded: fixtureStepId(GRADING_GROUPS.tier0, "notGraded"),
  probeDecided: fixtureStepId(GRADING_GROUPS.probes, "probeDecided"),
  probeOutOfRange: fixtureStepId(GRADING_GROUPS.probes, "probeOutOfRange"),
  probeError: fixtureStepId(GRADING_GROUPS.probes, "probeError"),
  probeUncertainThenJudge: fixtureStepId(GRADING_GROUPS.judge, "probeUncertainThenJudge"),
  judgeTiebreak: fixtureStepId(GRADING_GROUPS.judge, "judgeTiebreak"),
  judgeDisagrees: fixtureStepId(GRADING_GROUPS.uncertain, "judgeDisagrees"),
  stubModelJudge: fixtureStepId(GRADING_GROUPS.stub, "stubModelJudge"),
} as const;

export function gradingRunScenarioId(groupKey: string): string {
  const group = stepFixtureGroups().find((entry) => entry.key === groupKey);
  if (group === undefined) {
    throw new Error(`no step fixture group ${groupKey}`);
  }
  return fixtureRunScenarioId(group, STAGE_TWO_IDS.runs.showcase);
}
