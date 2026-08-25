import type { ContractDiff } from "@/lib/api/types";
import { CONTRACT_INTERFACE_IDS } from "./contracts-ids";

const STRING_TYPE = { type: "string" } as const;

const CALENDAR_CREATE_BREAKING: ContractDiff = {
  interface_id: CONTRACT_INTERFACE_IDS.calendar,
  path: "POST /api/v1/calendar/events",
  consumer_declares: {
    method: "POST",
    path: "/api/v1/calendar/events",
    auth_scheme: "bearer",
    request: {
      title: STRING_TYPE,
      start: { type: "string", format: "date" },
      end: { type: "string", format: "date" },
      attendees: { type: "array", items: STRING_TYPE },
      room: { type: "object", properties: { id: STRING_TYPE } },
      reminder_minutes: { type: "integer" },
    },
    reads: ["id", "start", "status"],
  },
  provider_accepts: {
    method: "POST",
    path: "/api/v1/calendar/events",
    auth_scheme: "bearer",
    request: {
      title: { type: "string", max_length: 120 },
      starts_at: { type: "string", format: "date-time" },
      ends_at: { type: "string", format: "date-time" },
      attendees: {
        type: "array",
        items: {
          type: "object",
          properties: { email: STRING_TYPE, role: STRING_TYPE },
        },
      },
      room_id: STRING_TYPE,
    },
    required: ["title", "starts_at", "ends_at"],
    reads: ["id", "starts_at", "status"],
  },
  verdict: "fail",
  message:
    "Gracie sends start and end as plain dates and attendees as email strings. Hotel operations requires starts_at and ends_at as ISO timestamps, attendees as objects and a room_id, and has no reminder_minutes field.",
};

const CALENDAR_READ_COMPATIBLE: ContractDiff = {
  interface_id: CONTRACT_INTERFACE_IDS.calendar,
  path: "GET /api/v1/calendar/events/{id}",
  consumer_declares: {
    method: "GET",
    path: "/api/v1/calendar/events/{id}",
    auth_scheme: "bearer",
    request: { path: { id: STRING_TYPE } },
    reads: ["id", "status"],
  },
  provider_accepts: {
    method: "GET",
    path: "/api/v1/calendar/events/{id}",
    auth_scheme: "bearer",
    request: { path: { id: STRING_TYPE } },
    reads: ["id", "status", "starts_at", "ends_at", "room_id"],
  },
  verdict: "pass",
  message:
    "Gracie reads only id and status. Hotel operations returns both, plus fields Gracie ignores.",
};

const HOUSEKEEPING_ASSIGN_BREAKING: ContractDiff = {
  interface_id: CONTRACT_INTERFACE_IDS.housekeeping,
  path: "POST /api/v1/housekeeping/tasks",
  consumer_declares: {
    method: "POST",
    path: "/api/v1/housekeeping/tasks",
    auth_scheme: "bearer",
    request: {
      room_id: STRING_TYPE,
      assignee_id: { type: "integer" },
      priority: { type: "string", enum: ["low", "normal", "urgent"] },
    },
    reads: ["id"],
  },
  provider_accepts: {
    method: "POST",
    path: "/api/v1/housekeeping/tasks",
    auth_scheme: "bearer",
    request: {
      room_id: STRING_TYPE,
      assignee_id: { type: "string", format: "uuid" },
      priority: { type: "string", enum: ["low", "normal", "urgent"] },
    },
    reads: ["id"],
  },
  verdict: "fail",
  message:
    "Gracie sends assignee_id as an integer. Hotel operations expects a UUID string and rejects the call with a 422.",
};

const GUEST_LOOKUP_UNCERTAIN: ContractDiff = {
  interface_id: CONTRACT_INTERFACE_IDS.guests,
  path: "GET /api/v1/guests/{id}",
  consumer_declares: {
    method: "GET",
    path: "/api/v1/guests/{id}",
    auth_scheme: "bearer",
    request: { path: { id: STRING_TYPE } },
    reads: ["id", "name", "loyalty_tier"],
  },
  provider_accepts: {
    method: "GET",
    path: "/api/v1/guests/{id}",
    auth_scheme: "bearer",
    request: { path: { id: STRING_TYPE } },
    response_declared: false,
  },
  verdict: "uncertain",
  message:
    "Hotel operations does not declare the fields this call returns, so Tessa cannot tell whether loyalty_tier exists. Ask the hotel operations team to declare the response.",
};

const NOTIFICATION_SKIPPED: ContractDiff = {
  interface_id: CONTRACT_INTERFACE_IDS.notifications,
  path: "POST /api/v1/notifications",
  consumer_declares: {
    method: "POST",
    path: "/api/v1/notifications",
    auth_scheme: "bearer",
    request: { channel: STRING_TYPE, body: STRING_TYPE },
  },
  provider_accepts: {},
  verdict: "skipped",
  message:
    "Hotel operations declares no interface for POST /api/v1/notifications, so there was nothing to compare.",
};

const ROOMS_LIST_COMPATIBLE: ContractDiff = {
  interface_id: CONTRACT_INTERFACE_IDS.rooms,
  path: "GET /api/v1/rooms",
  consumer_declares: {
    method: "GET",
    path: "/api/v1/rooms",
    auth_scheme: "bearer",
    request: { query: { floor: { type: "integer" } } },
    reads: ["id", "number", "floor"],
  },
  provider_accepts: {
    method: "GET",
    path: "/api/v1/rooms",
    auth_scheme: "bearer",
    request: { query: { floor: { type: "integer" } } },
    reads: ["id", "number", "floor"],
  },
  verdict: "pass",
  message: "The call and the fields Gracie reads match what hotel operations accepts.",
};

export const BREAKING_CHECK_ITEMS: readonly ContractDiff[] = [
  CALENDAR_CREATE_BREAKING,
  CALENDAR_READ_COMPATIBLE,
  HOUSEKEEPING_ASSIGN_BREAKING,
  GUEST_LOOKUP_UNCERTAIN,
  NOTIFICATION_SKIPPED,
  ROOMS_LIST_COMPATIBLE,
];

export const COMPATIBLE_CHECK_ITEMS: readonly ContractDiff[] = [
  CALENDAR_READ_COMPATIBLE,
  ROOMS_LIST_COMPATIBLE,
];

export const NO_CHECK_ITEMS: readonly ContractDiff[] = [];

export type ContractBehavior = "normal" | "compatible" | "empty" | "failing" | "slow";

export const CONTRACT_BEHAVIORS = [
  "normal",
  "compatible",
  "empty",
  "failing",
  "slow",
] as const satisfies readonly ContractBehavior[];

export const FAILING_AFTER_ITEMS = 2;
export const FAILING_REASON = "The comparison activity lost its worker connection";
export const DEFAULT_ITEM_GAP_MS = 700;
export const SLOW_ITEM_GAP_MS = 6000;

export function cloneItems(items: readonly ContractDiff[]): ContractDiff[] {
  return items.map((item) => structuredClone(item));
}

export function countBreaking(items: readonly ContractDiff[]): number {
  return items.filter((item) => item.verdict === "fail").length;
}
