import { ADMIN_USER } from "../factories/users";
import { startSuiteRun } from "../stage2/run-service";
import { STAGE_TWO_IDS } from "../stage2/seed-ids";
import type { MockState } from "../state";
import type { NotificationInput } from "./notifications-store";
import { stageEight } from "./store";

export const HOME_ACTIONS = [
  "notification",
  "invalidate",
  "finding",
  "budget_exhausted",
  "run",
] as const;

export type HomeAction = (typeof HOME_ACTIONS)[number];

const LIVE_NOTIFICATIONS: readonly NotificationInput[] = [
  {
    kind: "finding_regression",
    severity: "high",
    title: "A resolved finding came back",
    body: "A finding resolved last week failed again in the latest run.",
    link: "/findings",
    runId: null,
  },
  {
    kind: "run_finished",
    severity: "info",
    title: "Run finished",
    body: "A run of the Smart Log reads plan completed.",
    link: "/runs",
    runId: null,
  },
  {
    kind: "budget_exceeded",
    severity: "critical",
    title: "A run stopped at its budget",
    body: "A run reached its spending limit and was stopped.",
    link: `/runs/${STAGE_TWO_IDS.runs.budgetExceeded}`,
    runId: STAGE_TWO_IDS.runs.budgetExceeded,
  },
  {
    kind: "mutant_survived",
    severity: "medium",
    title: "A known bug slipped through",
    body: "A registered mutant survived the latest mutation run.",
    link: "/mutation",
    runId: null,
  },
];

const EXHAUSTED_LIMIT_USD = 2;
const EXHAUSTED_ACTUAL_USD = 2.31;

function emitNotification(): void {
  const template = LIVE_NOTIFICATIONS[stageEight.notificationCursor % LIVE_NOTIFICATIONS.length];
  stageEight.notificationCursor += 1;
  if (template === undefined) {
    return;
  }
  const created = stageEight.notifications.add(template);
  stageEight.bus.publish("notification.created", {
    notification_id: created.id,
    kind: created.kind,
    severity: created.severity,
    title: created.title,
    link: created.link,
  });
}

function emitFinding(state: MockState): void {
  const finding = state.stageFive.findings.createLive();
  stageEight.bumpSeverity(finding.severity);
  stageEight.bus.publish("dashboard.invalidate", {});
}

function startScheduledRun(state: MockState): void {
  startSuiteRun(
    state,
    ADMIN_USER,
    { planId: STAGE_TWO_IDS.plans.smartLog, plan: null, maxConcurrency: null, resetSeed: false },
    { trigger: "schedule" },
  );
}

export function runHomeAction(state: MockState, action: HomeAction): void {
  switch (action) {
    case "run":
      startScheduledRun(state);
      return;
    case "notification":
      emitNotification();
      return;
    case "invalidate":
      stageEight.bus.publish("dashboard.invalidate", {});
      return;
    case "finding":
      emitFinding(state);
      return;
    case "budget_exhausted":
      stageEight.bus.publish(
        "budget.exhausted",
        { dimension: "usd", limit: EXHAUSTED_LIMIT_USD, actual: EXHAUSTED_ACTUAL_USD },
        STAGE_TWO_IDS.runs.budgetExceeded,
      );
      return;
  }
}
