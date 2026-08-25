import { MockApiError, validationFailed } from "../factories/errors";
import { isUuid, newId } from "../factories/ids";
import { assertTeamBudget } from "../stage10/teams-guard";
import { BodyReader, type Source } from "../stage1/body";
import type { TargetRecord } from "../stage1/store";
import {
  evaluatePlan,
  missingRequiredVariables,
  notReady,
  planAsCreate,
  type Evaluation,
} from "../stage2/plan-service";
import { startSuiteRun } from "../stage2/run-service";
import { nowIso } from "../stage2/support";
import type { MockState } from "../state";
import type { ErrorDetail, MockUser } from "../types";
import type { Plan, RunGroup } from "@/lib/api/types";
import { runGroupStore } from "./run-group-store";
import { toRunGroup } from "./run-group-views";

export const RUN_GROUP_MAX_PLANS = 10;

export interface ParsedRunGroupCreate {
  planIds: string[];
}

interface Member {
  index: number;
  plan: Plan;
  evaluation: Evaluation;
}

function planLoc(index: number): ErrorDetail["loc"] {
  return ["body", "plan_ids", index];
}

export function parseRunGroupCreate(body: Source): ParsedRunGroupCreate {
  const reader = new BodyReader(body);
  const raw = reader.stringList("plan_ids", { maxItems: RUN_GROUP_MAX_PLANS });
  if (raw === undefined && !reader.has("plan_ids")) {
    reader.issue("plan_ids", "missing", "Field required");
  }
  const details = [...reader.details];
  const planIds = raw ?? [];
  if (details.length === 0 && planIds.length === 0) {
    details.push({
      loc: ["body", "plan_ids"],
      code: "too_short",
      message: "List should have at least 1 item after validation, not 0",
    });
  }
  const seen = new Set<string>();
  planIds.forEach((planId, index) => {
    if (!isUuid(planId)) {
      details.push({
        loc: planLoc(index),
        code: "uuid_parsing",
        message: "Input should be a valid UUID",
      });
      return;
    }
    if (seen.has(planId.toLowerCase())) {
      details.push({
        loc: planLoc(index),
        code: "duplicate_plan",
        message: "Each plan can be listed only once",
      });
    }
    seen.add(planId.toLowerCase());
  });
  if (details.length > 0) {
    throw validationFailed(details);
  }
  return { planIds: planIds.map((planId) => planId.toLowerCase()) };
}

function productionBlocked(target: TargetRecord, index: number): MockApiError {
  const message = `${target.name} is a production target and does not allow runs yet`;
  return new MockApiError(409, "production_blocked", message, [
    { loc: planLoc(index), code: "production_blocked", message },
    {
      loc: ["target", "allow_production"],
      code: "production_blocked",
      message: "An admin must enable allow_production for this target",
    },
  ]);
}

function resolveMembers(state: MockState, planIds: readonly string[]): Member[] {
  const details: ErrorDetail[] = [];
  const members: Member[] = [];
  const targetsSeen = new Map<string, number>();
  planIds.forEach((planId, index) => {
    const plan = state.stageTwo.findPlan(planId);
    if (plan === undefined) {
      details.push({ loc: planLoc(index), code: "plan_not_found", message: "Plan not found" });
      return;
    }
    if (targetsSeen.has(plan.target_id)) {
      details.push({
        loc: planLoc(index),
        code: "duplicate_target",
        message: "A run group takes one plan per target",
      });
      return;
    }
    targetsSeen.set(plan.target_id, index);
    members.push({ index, plan, evaluation: evaluatePlan(state, planAsCreate(plan)) });
  });
  if (details.length > 0) {
    throw validationFailed(details);
  }
  return members;
}

function assertStartable(state: MockState, member: Member): void {
  const { target, expansion } = member.evaluation;
  if (target.archivedAt !== null) {
    const message = `${target.name} is archived`;
    throw new MockApiError(409, "conflict", message, [
      { loc: planLoc(member.index), code: "target_archived", message },
    ]);
  }
  if (target.tier === "production" && !target.allowProduction) {
    throw productionBlocked(target, member.index);
  }
  if (expansion.cells.length === 0) {
    const message = `The plan for ${target.name} expands to no cells`;
    throw new MockApiError(422, "plan_empty", message, [
      { loc: planLoc(member.index), code: "plan_empty", message },
    ]);
  }
  const missing = missingRequiredVariables(state.stageOne, target.id, expansion.cells);
  if (missing.length > 0) {
    throw notReady(
      missing.map((name) => ({
        loc: ["environment", name],
        code: "env_missing",
        message: `Required variable ${name} of ${target.name} has no value`,
      })),
      `${target.name} is missing ${missing.length} required environment variable${missing.length === 1 ? "" : "s"}`,
    );
  }
  assertTeamBudget(state, target.id);
}

export function startRunGroup(
  state: MockState,
  user: MockUser,
  parsed: ParsedRunGroupCreate,
): RunGroup {
  const members = resolveMembers(state, parsed.planIds);
  if (state.faults.productionBlocked) {
    const production = members.find((member) => member.evaluation.target.tier === "production");
    const named = production ?? members[0];
    if (named !== undefined) {
      throw productionBlocked(named.evaluation.target, named.index);
    }
  }
  for (const member of members) {
    assertStartable(state, member);
  }
  const groupId = newId();
  const runIds = members.map((member) => {
    const handle = startSuiteRun(state, user, {
      planId: member.plan.id,
      plan: null,
      maxConcurrency: null,
      resetSeed: false,
    });
    const entry = state.stageTwo.findRun(handle.run_id);
    if (entry !== undefined) {
      entry.run.run_group_id = groupId;
    }
    return handle.run_id;
  });
  const record = { id: groupId, runIds, createdBy: user.id, createdAt: nowIso() };
  runGroupStore(state.stageTwo).add(record);
  return toRunGroup(state.stageTwo, record);
}
