import type { Budget, Schedule, ScheduleNotify, ScheduleTier } from "@/lib/api/types";
import { newId } from "../factories/ids";
import { stableId } from "../stage2/ids";
import { STAGE_TWO_IDS } from "../stage2/seed-ids";
import { mockState } from "../state";
import { nextCronRun } from "./cron";

export type SchedulesSeed = "default" | "empty";

export const SCHEDULES_SEEDS = ["default", "empty"] as const satisfies readonly SchedulesSeed[];

export const SCHEDULE_IDS = {
  nightly: stableId("seed_schedule", "nightly"),
  weekly: stableId("seed_schedule", "weekly"),
  commit: stableId("seed_schedule", "commit"),
} as const;

export interface NewSchedule {
  plan_id: string;
  tier: ScheduleTier;
  cron: string | null;
  timezone: string;
  enabled: boolean;
  budget: Budget | null;
  notify: ScheduleNotify;
}

export interface StoredSchedule {
  schedule: Schedule;
  order: number;
}

export function temporalScheduleIdOf(scheduleId: string): string {
  return `scheduled-run-${scheduleId}`;
}

function seededSchedules(): Schedule[] {
  return [
    {
      id: SCHEDULE_IDS.nightly,
      plan_id: STAGE_TWO_IDS.plans.smartLog,
      tier: "nightly",
      cron: "0 2 * * *",
      timezone: "America/New_York",
      enabled: true,
      budget: { max_usd: 3, max_minutes: 20 },
      notify: { slack: true, email: ["qa-lead@example.test"] },
      temporal_schedule_id: temporalScheduleIdOf(SCHEDULE_IDS.nightly),
      last_run_id: STAGE_TWO_IDS.runs.completed,
      next_run_at: null,
    },
    {
      id: SCHEDULE_IDS.weekly,
      plan_id: STAGE_TWO_IDS.plans.guestFlows,
      tier: "weekly",
      cron: "30 6 * * 1",
      timezone: "Europe/Berlin",
      enabled: false,
      budget: null,
      notify: { slack: false, email: [] },
      temporal_schedule_id: temporalScheduleIdOf(SCHEDULE_IDS.weekly),
      last_run_id: null,
      next_run_at: null,
    },
    {
      id: SCHEDULE_IDS.commit,
      plan_id: STAGE_TWO_IDS.plans.apiSweep,
      tier: "commit",
      cron: null,
      timezone: "UTC",
      enabled: true,
      budget: null,
      notify: { slack: true, email: [] },
      temporal_schedule_id: temporalScheduleIdOf(SCHEDULE_IDS.commit),
      last_run_id: null,
      next_run_at: null,
    },
  ];
}

function nextRunOf(schedule: Schedule, now: Date): string | null {
  if (!schedule.enabled || schedule.cron === null) {
    return null;
  }
  return nextCronRun(schedule.cron, schedule.timezone, now)?.toISOString() ?? null;
}

export function viewOfSchedule(schedule: Schedule, now: Date = new Date()): Schedule {
  return {
    ...schedule,
    budget: schedule.budget === null ? null : { ...schedule.budget },
    notify: { slack: schedule.notify.slack, email: [...schedule.notify.email] },
    next_run_at: nextRunOf(schedule, now),
  };
}

export class SchedulesStore {
  private currentSeed: SchedulesSeed = "default";
  private seeded = false;
  private rows: StoredSchedule[] = [];
  private ordinal = 0;

  get seed(): SchedulesSeed {
    return this.currentSeed;
  }

  reset(seed: SchedulesSeed = "default"): void {
    for (const { schedule } of this.rows) {
      this.linkPlan(schedule.plan_id, null);
    }
    this.currentSeed = seed;
    this.seeded = false;
    this.rows = [];
    this.ordinal = 0;
  }

  all(): StoredSchedule[] {
    this.ensure();
    return this.rows;
  }

  find(scheduleId: string): StoredSchedule | undefined {
    return this.all().find((row) => row.schedule.id === scheduleId);
  }

  findByPlan(planId: string): StoredSchedule | undefined {
    return this.all().find((row) => row.schedule.plan_id === planId);
  }

  create(input: NewSchedule): Schedule {
    this.ensure();
    const id = newId();
    const schedule: Schedule = {
      id,
      ...input,
      temporal_schedule_id: temporalScheduleIdOf(id),
      last_run_id: null,
      next_run_at: null,
    };
    this.append(schedule);
    this.linkPlan(schedule.plan_id, id);
    return schedule;
  }

  remove(scheduleId: string): boolean {
    const row = this.find(scheduleId);
    if (row === undefined) {
      return false;
    }
    this.rows = this.rows.filter((candidate) => candidate !== row);
    this.linkPlan(row.schedule.plan_id, null);
    return true;
  }

  private ensure(): void {
    if (this.seeded) {
      return;
    }
    this.seeded = true;
    if (this.currentSeed === "empty") {
      return;
    }
    for (const schedule of seededSchedules()) {
      if (mockState.stageTwo.findPlan(schedule.plan_id) === undefined) {
        continue;
      }
      this.append(schedule);
      this.linkPlan(schedule.plan_id, schedule.id);
    }
  }

  private append(schedule: Schedule): void {
    this.ordinal += 1;
    this.rows.push({ schedule, order: this.ordinal });
  }

  private linkPlan(planId: string, scheduleId: string | null): void {
    const plan = mockState.stageTwo.findPlan(planId);
    if (plan !== undefined) {
      plan.schedule_id = scheduleId;
    }
  }
}

export const schedulesStore = new SchedulesStore();

mockState.stageTwo.onReset(() => schedulesStore.reset());
