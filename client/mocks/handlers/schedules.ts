import { http } from "msw";
import { ADMIN_USER } from "../factories/users";
import { conflict, dependencyUnavailable, notFound, validationFailed } from "../factories/errors";
import { QueryReader, readPage, type PageSpec } from "../factories/pagination";
import { parseJsonObject } from "../factories/validation";
import { SERVICE_KEY_HEADER } from "../config";
import { hashParts, pathUuid, requireIdempotencyKey, withIdempotency } from "../stage1/support";
import { startSuiteRun } from "../stage2/run-service";
import { stageTwo } from "../stage2/support";
import {
  checkTierAndCron,
  parseScheduleCreate,
  parseScheduleUpdate,
  SCHEDULE_TIERS,
  type ScheduleChanges,
} from "../stage8/schedule-service";
import { schedulesStore, viewOfSchedule, type StoredSchedule } from "../stage8/schedules-store";
import type { ErrorDetail, MockUser } from "../types";
import type { Schedule } from "@/lib/api/types";
import { api, jsonResponse, requireServiceKey, requireUser, type ApiContext } from "./api";

interface ScheduleRow {
  order: number;
  schedule: Schedule;
}

const SCHEDULE_PAGE: PageSpec<ScheduleRow> = {
  sortKeys: { created_at: { kind: "number", value: (row) => row.order } },
  defaultSort: "created_at",
  getId: (row) => row.schedule.id,
};

function requireTemporal(context: ApiContext): void {
  if (context.state.faults.isDependencyDown("temporal")) {
    throw dependencyUnavailable("temporal", "Temporal is not running");
  }
}

function requireStored(context: ApiContext): StoredSchedule {
  const stored = schedulesStore.find(pathUuid(context, "schedule_id"));
  if (stored === undefined) {
    throw notFound("Schedule not found");
  }
  return stored;
}

async function listSchedules(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const query = new QueryReader(context.url.searchParams);
  const planId = query.uuid("plan_id");
  const tiers = query.enumList("tier", SCHEDULE_TIERS);
  const enabledText = query.text("enabled");
  const enabled = enabledText === undefined ? undefined : query.boolean("enabled", true);
  const paginate = readPage(query, SCHEDULE_PAGE);
  query.finish();
  const now = new Date();
  const rows = schedulesStore
    .all()
    .filter(({ schedule }) => planId === undefined || schedule.plan_id === planId.toLowerCase())
    .filter(({ schedule }) => tiers === undefined || tiers.includes(schedule.tier))
    .filter(({ schedule }) => enabled === undefined || schedule.enabled === enabled)
    .map(
      ({ order, schedule }): ScheduleRow => ({
        order,
        schedule: viewOfSchedule(schedule, now),
      }),
    );
  const page = paginate(rows);
  return jsonResponse({ ...page, items: page.items.map((row) => row.schedule) });
}

async function createSchedule(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  const raw = await context.request.text();
  const input = parseScheduleCreate(parseJsonObject(raw));
  return withIdempotency(
    context,
    user,
    { required: false, requestHash: hashParts("POST", context.url.pathname, raw) },
    () => {
      requireTemporal(context);
      if (stageTwo(context).findPlan(input.plan_id) === undefined) {
        throw notFound("Plan not found");
      }
      if (schedulesStore.findByPlan(input.plan_id) !== undefined) {
        throw conflict("conflict", "This plan already has a schedule");
      }
      return { status: 201, body: viewOfSchedule(schedulesStore.create(input)) };
    },
  );
}

async function readSchedule(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  return jsonResponse(viewOfSchedule(requireStored(context).schedule));
}

function merge(current: Schedule, changes: ScheduleChanges): Schedule {
  return {
    ...current,
    tier: changes.tier ?? current.tier,
    cron: changes.cron === undefined ? current.cron : changes.cron,
    timezone: changes.timezone ?? current.timezone,
    enabled: changes.enabled ?? current.enabled,
    budget: changes.budget === undefined ? current.budget : changes.budget,
    notify: changes.notify ?? current.notify,
  };
}

async function updateSchedule(context: ApiContext): Promise<Response> {
  await requireUser(context, "member");
  const stored = requireStored(context);
  const changes = parseScheduleUpdate(parseJsonObject(await context.request.text()));
  const next = merge(stored.schedule, changes);
  const details: ErrorDetail[] = [];
  checkTierAndCron(next.tier, next.cron, details);
  if (details.length > 0) {
    throw validationFailed(details);
  }
  requireTemporal(context);
  stored.schedule = next;
  return jsonResponse(viewOfSchedule(next));
}

async function deleteSchedule(context: ApiContext): Promise<Response> {
  await requireUser(context, "member");
  const stored = requireStored(context);
  requireTemporal(context);
  schedulesStore.remove(stored.schedule.id);
  return new Response(null, { status: 204 });
}

async function memberOrService(context: ApiContext): Promise<MockUser> {
  if (context.request.headers.has(SERVICE_KEY_HEADER)) {
    requireServiceKey(context);
    return ADMIN_USER;
  }
  return requireUser(context, "member");
}

async function runScheduleNow(context: ApiContext): Promise<Response> {
  const user = await memberOrService(context);
  requireIdempotencyKey(context);
  const stored = requireStored(context);
  return withIdempotency(
    context,
    user,
    { required: true, requestHash: hashParts("POST", context.url.pathname) },
    () => {
      requireTemporal(context);
      const { schedule } = stored;
      const handle = startSuiteRun(
        context.state,
        user,
        { planId: schedule.plan_id, plan: null, maxConcurrency: null, resetSeed: false },
        { trigger: "schedule", budget: schedule.budget ?? undefined },
      );
      stored.schedule = { ...schedule, last_run_id: handle.run_id };
      return { status: 202, body: handle };
    },
  );
}

export const scheduleHandlers = [
  http.get("*/api/v1/schedules", api(listSchedules)),
  http.post("*/api/v1/schedules", api(createSchedule)),
  http.post("*/api/v1/schedules/:schedule_id/run-now", api(runScheduleNow)),
  http.get("*/api/v1/schedules/:schedule_id", api(readSchedule)),
  http.patch("*/api/v1/schedules/:schedule_id", api(updateSchedule)),
  http.delete("*/api/v1/schedules/:schedule_id", api(deleteSchedule)),
];
