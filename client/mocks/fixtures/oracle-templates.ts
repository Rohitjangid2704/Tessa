import type { OracleApproval, OracleLanguage } from "@/lib/api/types";

export const ORACLE_TEMPLATE_IDS = {
  openMaintenance: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3ba001",
  issueDetail: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3ba002",
  roomsInventory: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3ba003",
  guestRequestsExport: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3ba004",
  lateCheckouts: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3ba005",
  staffRoster: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3ba006",
  slowOccupancy: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3ba007",
  failingExport: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3ba008",
  rawSqlProbe: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3ba009",
  escalationRules: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3ba00a",
  legacyRoomStatus: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3ba00b",
} as const;

export const ORACLE_RESULT_IDS = {
  openMaintenanceOk: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3bb001",
  openMaintenanceError: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3bb002",
  issueDetailOk: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3bb003",
  staffRosterOk: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3bb004",
  legacyRoomStatusOk: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3bb005",
} as const;

export const DEFAULT_ORACLE_SETTLE_MS = 300;
export const SLOW_ORACLE_SETTLE_MS = 2000;
export const ORACLE_MAX_ROWS = 200;

export type OracleRowsKind =
  "maintenance" | "single" | "inventory" | "truncated" | "empty" | "ragged" | "occupancy";

export interface OracleBehavior {
  rows: OracleRowsKind;
  settleMs: number;
  durationMs: number;
  errorMessage?: string;
}

export interface OracleTemplateSeed {
  id: string;
  name: string;
  featureIds: string[];
  language: OracleLanguage;
  source: string;
  paramsSchema: Record<string, unknown>;
  sentenceTemplate: string;
  readOnlyVerified: boolean;
  approval: OracleApproval;
  behavior: OracleBehavior;
}

const TENANT_PROPERTY = {
  type: "string",
  title: "Tenant",
  description: "Property id the query is scoped to",
  minLength: 3,
  default: "gracie-demo",
};

const AS_OF_PROPERTY = {
  type: "string",
  format: "date",
  title: "As of",
  description: "Day the expectation is computed for",
  default: "2026-10-01",
};

const ROLE_PROPERTY = {
  type: "string",
  title: "Role",
  description: "Manifest role the question is asked as",
  enum: ["front_desk", "housekeeping_lead", "manager"],
  default: "front_desk",
};

const TENANT_ONLY_SCHEMA = {
  type: "object",
  required: ["tenant_id"],
  additionalProperties: false,
  properties: { tenant_id: TENANT_PROPERTY },
};

const TENANT_AND_DATE_SCHEMA = {
  type: "object",
  required: ["tenant_id", "as_of"],
  additionalProperties: false,
  properties: { tenant_id: TENANT_PROPERTY, as_of: AS_OF_PROPERTY },
};

const OPEN_MAINTENANCE_SOURCE = `SELECT i.id            AS issue_id,
       r.room_number   AS room,
       i.category      AS category,
       i.status        AS status,
       i.opened_at     AS opened_at,
       u.display_name  AS assigned_to
FROM smart_log.issues AS i
JOIN property.rooms AS r ON r.id = i.room_id
LEFT JOIN staff.users AS u ON u.id = i.assigned_user_id
WHERE i.tenant_id = :tenant_id
  AND i.opened_at::date <= :as_of::date
  AND (i.status = 'open' OR :include_closed)
ORDER BY i.opened_at DESC
LIMIT :limit;
`;

const ISSUE_DETAIL_SOURCE = `SELECT i.id AS issue_id, i.category, i.status, i.description, i.opened_at, i.closed_at
FROM smart_log.issues AS i
WHERE i.tenant_id = :tenant_id
  AND i.id = :issue_id;
`;

const ROOMS_INVENTORY_SOURCE = `SELECT r.room_number, r.floor, r.room_type, r.status
FROM property.rooms AS r
WHERE r.tenant_id = :tenant_id
ORDER BY r.floor, r.room_number;
`;

const GUEST_REQUESTS_EXPORT_SOURCE = `SELECT g.id, g.room_number, g.kind, g.state, g.created_at
FROM guest_requests.requests AS g
WHERE g.tenant_id = :tenant_id
ORDER BY g.created_at DESC;
`;

const LATE_CHECKOUTS_SOURCE = `SELECT s.room_number, s.guest_name, s.expected_checkout_at
FROM stays.stays AS s
WHERE s.tenant_id = :tenant_id
  AND s.expected_checkout_at::date = :as_of::date
  AND s.expected_checkout_at::time > TIME '12:00';
`;

const STAFF_ROSTER_SOURCE = `def run(connection, params):
    rows = connection.fetch_all(
        "SELECT user_id, display_name, shifts, contact FROM staff.roster WHERE tenant_id = %s",
        [params["tenant_id"]],
    )
    return [
        {
            "display_name": row["display_name"],
            "shifts": row["shifts"],
            **({"contact": row["contact"]} if row["contact"] else {}),
        }
        for row in rows
    ]
`;

const SLOW_OCCUPANCY_SOURCE = `SELECT date_trunc('hour', s.checked_in_at) AS hour,
       count(*)                       AS arrivals,
       count(*) FILTER (WHERE s.late) AS late_arrivals
FROM stays.stays AS s
WHERE s.tenant_id = :tenant_id
  AND s.checked_in_at::date = :as_of::date
GROUP BY 1
ORDER BY 1;
`;

const FAILING_EXPORT_SOURCE = `SELECT *
FROM audit.event_log AS e
WHERE e.tenant_id = :tenant_id
ORDER BY e.created_at;
`;

const RAW_SQL_PROBE_SOURCE = `SELECT * FROM public.refresh_room_snapshot(:tenant_id);
`;

const ESCALATION_RULES_SOURCE = `SELECT rule_id, severity, notify_after_minutes
FROM ops.escalation_rules
WHERE tenant_id = :tenant_id
  AND severity = ANY(:severities);
`;

const LEGACY_ROOM_STATUS_SOURCE = `SELECT room_number, status FROM property.rooms_v1 WHERE tenant_id = :tenant_id;
`;

const ESCALATION_RULES_SCHEMA = {
  type: "object",
  required: ["tenant_id", "severities"],
  properties: {
    tenant_id: TENANT_PROPERTY,
    severities: {
      type: "array",
      items: { type: "string", enum: ["low", "medium", "high"] },
      minItems: 1,
    },
  },
};

export const ORACLE_TEMPLATE_SEEDS: readonly OracleTemplateSeed[] = [
  {
    id: ORACLE_TEMPLATE_IDS.openMaintenance,
    name: "open_maintenance",
    featureIds: ["smart_log.read.open_maintenance"],
    language: "sql",
    source: OPEN_MAINTENANCE_SOURCE,
    paramsSchema: {
      type: "object",
      required: ["tenant_id", "as_of", "role"],
      additionalProperties: false,
      properties: {
        tenant_id: TENANT_PROPERTY,
        as_of: AS_OF_PROPERTY,
        role: ROLE_PROPERTY,
        limit: {
          type: "integer",
          title: "Row limit",
          minimum: 1,
          maximum: 200,
          default: 50,
        },
        include_closed: {
          type: "boolean",
          title: "Include closed issues",
          default: false,
        },
      },
    },
    sentenceTemplate:
      "{row_count} maintenance issues are open for {tenant_id} on {as_of}; the newest is in room {first.room} ({first.category}).",
    readOnlyVerified: true,
    approval: "unreviewed",
    behavior: { rows: "maintenance", settleMs: DEFAULT_ORACLE_SETTLE_MS, durationMs: 42 },
  },
  {
    id: ORACLE_TEMPLATE_IDS.issueDetail,
    name: "issue_detail",
    featureIds: ["smart_log.read.issue_detail"],
    language: "sql",
    source: ISSUE_DETAIL_SOURCE,
    paramsSchema: {
      type: "object",
      required: ["tenant_id", "issue_id"],
      additionalProperties: false,
      properties: {
        tenant_id: TENANT_PROPERTY,
        issue_id: { type: "integer", title: "Issue id", minimum: 1, default: 1042 },
      },
    },
    sentenceTemplate:
      "Issue {issue_id} is a {first.category} issue and its status is {first.status}.",
    readOnlyVerified: true,
    approval: "approved",
    behavior: { rows: "single", settleMs: DEFAULT_ORACLE_SETTLE_MS, durationMs: 11 },
  },
  {
    id: ORACLE_TEMPLATE_IDS.roomsInventory,
    name: "rooms_inventory",
    featureIds: ["reports.read.occupancy_summary"],
    language: "sql",
    source: ROOMS_INVENTORY_SOURCE,
    paramsSchema: TENANT_ONLY_SCHEMA,
    sentenceTemplate: "{tenant_id} has {row_count} rooms on record.",
    readOnlyVerified: true,
    approval: "unreviewed",
    behavior: { rows: "inventory", settleMs: DEFAULT_ORACLE_SETTLE_MS, durationMs: 87 },
  },
  {
    id: ORACLE_TEMPLATE_IDS.guestRequestsExport,
    name: "guest_requests_export",
    featureIds: ["guest_requests.read.list_open", "reports.flow.export_week"],
    language: "sql",
    source: GUEST_REQUESTS_EXPORT_SOURCE,
    paramsSchema: TENANT_ONLY_SCHEMA,
    sentenceTemplate: "{tenant_id} has at least {row_count} guest requests (the result is cut).",
    readOnlyVerified: true,
    approval: "unreviewed",
    behavior: { rows: "truncated", settleMs: DEFAULT_ORACLE_SETTLE_MS, durationMs: 412 },
  },
  {
    id: ORACLE_TEMPLATE_IDS.lateCheckouts,
    name: "late_checkouts",
    featureIds: ["guest_requests.write.create_service_request"],
    language: "sql",
    source: LATE_CHECKOUTS_SOURCE,
    paramsSchema: TENANT_AND_DATE_SCHEMA,
    sentenceTemplate: "No late checkouts are expected for {tenant_id} on {as_of}.",
    readOnlyVerified: true,
    approval: "unreviewed",
    behavior: { rows: "empty", settleMs: DEFAULT_ORACLE_SETTLE_MS, durationMs: 9 },
  },
  {
    id: ORACLE_TEMPLATE_IDS.staffRoster,
    name: "staff_roster",
    featureIds: ["access.read.who_am_i", "access.admin.manage_roles"],
    language: "python",
    source: STAFF_ROSTER_SOURCE,
    paramsSchema: TENANT_ONLY_SCHEMA,
    sentenceTemplate: "{row_count} staff members are rostered for {tenant_id}.",
    readOnlyVerified: true,
    approval: "approved",
    behavior: { rows: "ragged", settleMs: DEFAULT_ORACLE_SETTLE_MS, durationMs: 133 },
  },
  {
    id: ORACLE_TEMPLATE_IDS.slowOccupancy,
    name: "slow_occupancy_report",
    featureIds: ["reports.read.occupancy_summary"],
    language: "sql",
    source: SLOW_OCCUPANCY_SOURCE,
    paramsSchema: TENANT_AND_DATE_SCHEMA,
    sentenceTemplate: "{row_count} arrival hours are recorded for {tenant_id} on {as_of}.",
    readOnlyVerified: true,
    approval: "unreviewed",
    behavior: { rows: "occupancy", settleMs: SLOW_ORACLE_SETTLE_MS, durationMs: 1873 },
  },
  {
    id: ORACLE_TEMPLATE_IDS.failingExport,
    name: "failing_export",
    featureIds: ["reports.flow.export_week"],
    language: "sql",
    source: FAILING_EXPORT_SOURCE,
    paramsSchema: TENANT_ONLY_SCHEMA,
    sentenceTemplate: "{row_count} audit events exist for {tenant_id}.",
    readOnlyVerified: true,
    approval: "unreviewed",
    behavior: {
      rows: "maintenance",
      settleMs: DEFAULT_ORACLE_SETTLE_MS,
      durationMs: 10000,
      errorMessage:
        "canceling statement due to statement timeout (TESSA_ORACLE_STATEMENT_TIMEOUT_MS=10000)",
    },
  },
  {
    id: ORACLE_TEMPLATE_IDS.rawSqlProbe,
    name: "refresh_room_snapshot",
    featureIds: ["smart_log.read.open_maintenance"],
    language: "sql",
    source: RAW_SQL_PROBE_SOURCE,
    paramsSchema: TENANT_ONLY_SCHEMA,
    sentenceTemplate: "{row_count} rows came back from the snapshot refresh.",
    readOnlyVerified: false,
    approval: "unreviewed",
    behavior: { rows: "single", settleMs: DEFAULT_ORACLE_SETTLE_MS, durationMs: 64 },
  },
  {
    id: ORACLE_TEMPLATE_IDS.escalationRules,
    name: "escalation_rules",
    featureIds: ["streaming.job.escalation_sweep"],
    language: "sql",
    source: ESCALATION_RULES_SOURCE,
    paramsSchema: ESCALATION_RULES_SCHEMA,
    sentenceTemplate: "{row_count} escalation rules apply to {tenant_id}.",
    readOnlyVerified: true,
    approval: "unreviewed",
    behavior: { rows: "single", settleMs: DEFAULT_ORACLE_SETTLE_MS, durationMs: 18 },
  },
  {
    id: ORACLE_TEMPLATE_IDS.legacyRoomStatus,
    name: "legacy_room_status",
    featureIds: ["reports.read.occupancy_summary"],
    language: "sql",
    source: LEGACY_ROOM_STATUS_SOURCE,
    paramsSchema: TENANT_ONLY_SCHEMA,
    sentenceTemplate: "{row_count} rooms are listed in the legacy table.",
    readOnlyVerified: true,
    approval: "rejected",
    behavior: { rows: "single", settleMs: DEFAULT_ORACLE_SETTLE_MS, durationMs: 23 },
  },
];
