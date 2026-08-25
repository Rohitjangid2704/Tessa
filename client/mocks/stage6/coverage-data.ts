import { slugify } from "../factories/targets";
import type { BundleRecord } from "../stage1/store";
import { stableId, stableInt, stableUnit } from "../stage2/ids";
import type { AdapterKind, CellStatus, SkipReason, VerdictStatus } from "@/lib/api/types";

export type CoverageSeed = "large" | "bundle" | "empty";

export const DEFAULT_COVERAGE_SEED: CoverageSeed = "large";

export const COVERAGE_SEEDS: readonly CoverageSeed[] = ["large", "bundle", "empty"];

export interface CoverageRowRecord {
  feature_id: string;
  area: string;
  title: string;
}

export interface CoverageColumnRecord {
  role: string;
  interface_id: string;
  interfaceKind: AdapterKind;
  basePath: string;
}

export interface CoverageCellState {
  id: string;
  featureId: string;
  area: string;
  title: string;
  role: string;
  interfaceId: string;
  interfaceKind: AdapterKind;
  basePath: string;
  status: CellStatus;
  scenarioCount: number;
  lastVerdict: VerdictStatus | null;
  reason: string | null;
  skipReason: SkipReason | null;
}

export interface CoverageDataset {
  targetId: string;
  bundleId: string;
  bundleVersion: number;
  rows: CoverageRowRecord[];
  columns: CoverageColumnRecord[];
  cells: CoverageCellState[];
}

const PADDED_FEATURE_COUNT = 60;
const PADDING_MARKER_FEATURE = "smart_log.read.open_maintenance";
const COLUMN_PICK_THRESHOLD = 0.62;
const MIN_PADDED_CELLS = 2;

const PADDED_COLUMNS: ReadonlyArray<{ role: string; interfaceId: string }> = [
  { role: "guest", interfaceId: "chat_sse" },
  { role: "guest", interfaceId: "browser" },
  { role: "front_desk", interfaceId: "rest_api" },
  { role: "housekeeping_lead", interfaceId: "chat_sse" },
  { role: "manager", interfaceId: "rest_api" },
  { role: "admin", interfaceId: "rest_api" },
];

const PADDED_FEATURES: readonly string[] = [
  "Smart Log|smart_log.read.overdue_issues|List maintenance issues that are overdue",
  "Smart Log|smart_log.read.issues_by_room|Show every maintenance issue of one room",
  "Smart Log|smart_log.write.assign_issue|Assign a maintenance issue to a technician",
  "Smart Log|smart_log.write.reopen_issue|Reopen a closed maintenance issue",
  "Smart Log|smart_log.read.technician_workload|Summarise open work per technician",
  "Smart Log|smart_log.write.add_photo|Attach a photo to a maintenance issue",
  "Smart Log|smart_log.read.issue_history|Show the history of one maintenance issue",
  "Guest Requests|guest_requests.read.request_status|Check the status of one guest request",
  "Guest Requests|guest_requests.write.cancel_request|Cancel an open guest request",
  "Guest Requests|guest_requests.write.escalate_request|Escalate a guest request to a manager",
  "Guest Requests|guest_requests.read.requests_by_room|List the guest requests of one room",
  "Guest Requests|guest_requests.write.add_note|Add an internal note to a guest request",
  "Guest Requests|guest_requests.read.sla_breaches|List requests that missed their response target",
  "Guest Requests|guest_requests.flow.rate_service|Let a guest rate a completed request",
  "Account & Access|access.auth.logout|Sign out and revoke the session",
  "Account & Access|access.auth.reset_password|Reset a forgotten password",
  "Account & Access|access.read.list_staff|List the staff accounts of the property",
  "Account & Access|access.admin.deactivate_staff|Deactivate a staff account",
  "Account & Access|access.admin.invite_staff|Invite a new staff member by email",
  "Account & Access|access.read.audit_log|Read the audit log of sign-ins",
  "Reports|reports.read.revenue_summary|Summarise revenue for a date range",
  "Reports|reports.read.adr_trend|Show the average daily rate trend",
  "Reports|reports.read.housekeeping_throughput|Show rooms cleaned per shift",
  "Reports|reports.read.guest_satisfaction|Summarise guest satisfaction scores",
  "Reports|reports.read.no_show_rate|Show the no-show rate per week",
  "Reports|reports.flow.schedule_report|Schedule a report to arrive by email",
  "Reports|reports.flow.share_report|Share a report with another manager",
  "Reports|reports.read.channel_mix|Show bookings by sales channel",
  "Streaming & Jobs|streaming.stream.chat_history|Replay the history of a chat",
  "Streaming & Jobs|streaming.stream.typing_indicator|Show the typing indicator while Gracie answers",
  "Streaming & Jobs|streaming.job.nightly_digest|Send the nightly digest to managers",
  "Streaming & Jobs|streaming.job.sync_pms|Sync reservations from the property system",
  "Streaming & Jobs|streaming.stream.room_events|Stream room status changes",
  "Streaming & Jobs|streaming.job.cleanup_sessions|Remove expired sessions",
  "Streaming & Jobs|streaming.stream.alert_feed|Stream operational alerts to the front desk",
  "Billing & Folios|billing.read.folio_balance|Read the balance of a guest folio",
  "Billing & Folios|billing.read.list_invoices|List the invoices of a stay",
  "Billing & Folios|billing.write.post_charge|Post a charge to a folio",
  "Billing & Folios|billing.write.void_charge|Void a charge on a folio",
  "Billing & Folios|billing.write.apply_discount|Apply a discount to a folio",
  "Billing & Folios|billing.flow.checkout_payment|Pay the folio at checkout",
  "Billing & Folios|billing.read.tax_breakdown|Show the tax breakdown of an invoice",
  "Billing & Folios|billing.job.nightly_audit|Run the nightly audit of folios",
  "Billing & Folios|billing.read.payment_methods|List the stored payment methods",
  "Billing & Folios|billing.write.refund_payment|Refund a payment to the guest",
];

const NEEDS_AUTHOR_REASONS: readonly string[] = [
  "The bundle has no example for this feature, so there is nothing to generate from. Write one with Claude Code and upload the bundle again.",
  "The check needs a seeded record, such as a guest with an open request, that the server cannot create.",
  "The expected result depends on a database row only the owner of the repository can describe.",
  "The feature needs a clock pin that Tessa cannot generate; author the scenario with the hook in place.",
];

interface BlockedReason {
  skipReason: SkipReason;
  reason: string;
}

const BLOCKED_REASONS: readonly BlockedReason[] = [
  {
    skipReason: "env_missing",
    reason: "A required environment value has no value, so this role cannot sign in.",
  },
  {
    skipReason: "service_down",
    reason: "The interface failed its last health check.",
  },
  {
    skipReason: "flag_disabled",
    reason: "A feature flag this cell depends on is off in the environment.",
  },
  {
    skipReason: "hook_missing",
    reason: "The app does not offer the hook this cell needs, such as a seed reset.",
  },
  {
    skipReason: "role_unavailable",
    reason: "No credentials exist for the role of this cell.",
  },
];

const COVERED_LIMIT = 0.34;
const GENERATED_LIMIT = 0.52;
const EMPTY_LIMIT = 0.78;
const NEEDS_AUTHOR_LIMIT = 0.9;
const PASS_LIMIT = 0.62;
const FAIL_LIMIT = 0.78;
const FLAKY_LIMIT = 0.9;

function statusFor(featureId: string, role: string, interfaceId: string): CellStatus {
  const roll = stableUnit("coverage_status", featureId, role, interfaceId);
  if (roll < COVERED_LIMIT) {
    return "covered";
  }
  if (roll < GENERATED_LIMIT) {
    return "generated";
  }
  if (roll < EMPTY_LIMIT) {
    return "empty";
  }
  return roll < NEEDS_AUTHOR_LIMIT ? "needs_author" : "blocked";
}

function verdictFor(featureId: string, role: string, interfaceId: string): VerdictStatus {
  const roll = stableUnit("coverage_verdict", featureId, role, interfaceId);
  if (roll < PASS_LIMIT) {
    return "pass";
  }
  if (roll < FAIL_LIMIT) {
    return "fail";
  }
  return roll < FLAKY_LIMIT ? "flaky" : "uncertain";
}

interface CellSeedInput {
  targetId: string;
  bundleId: string;
  featureId: string;
  area: string;
  title: string;
  column: CoverageColumnRecord;
}

function buildCell(input: CellSeedInput): CoverageCellState {
  const { targetId, bundleId, featureId, area, title, column } = input;
  const { role, interface_id: interfaceId } = column;
  const status = statusFor(featureId, role, interfaceId);
  const blocked =
    status === "blocked"
      ? BLOCKED_REASONS[
          stableInt(0, BLOCKED_REASONS.length - 1, "coverage_blocked", featureId, role, interfaceId)
        ]
      : undefined;
  const needsAuthor =
    status === "needs_author"
      ? NEEDS_AUTHOR_REASONS[
          stableInt(
            0,
            NEEDS_AUTHOR_REASONS.length - 1,
            "coverage_author",
            featureId,
            role,
            interfaceId,
          )
        ]
      : undefined;
  let scenarioCount = 0;
  if (status === "covered") {
    scenarioCount = stableInt(1, 3, "coverage_count", featureId, role, interfaceId);
  } else if (status === "generated") {
    scenarioCount = stableInt(1, 2, "coverage_count", featureId, role, interfaceId);
  }
  let lastVerdict: VerdictStatus | null = null;
  if (status === "covered") {
    lastVerdict = verdictFor(featureId, role, interfaceId);
  } else if (status === "blocked") {
    lastVerdict = "skipped";
  }
  return {
    id: stableId("coverage_cell", targetId, bundleId, featureId, role, interfaceId),
    featureId,
    area,
    title,
    role,
    interfaceId,
    interfaceKind: column.interfaceKind,
    basePath: column.basePath,
    status,
    scenarioCount,
    lastVerdict,
    reason: blocked?.reason ?? needsAuthor ?? null,
    skipReason: blocked?.skipReason ?? null,
  };
}

function firstSentence(text: string): string {
  const trimmed = text.trim().replace(/\.$/, "");
  return trimmed.length === 0 ? "Untitled feature" : trimmed;
}

function isPaddable(record: BundleRecord): boolean {
  return record.features.some((feature) => feature.feature_id === PADDING_MARKER_FEATURE);
}

function columnOf(
  record: BundleRecord,
  role: string,
  interfaceId: string,
): CoverageColumnRecord | null {
  const entry = record.interfaces.find((candidate) => candidate.id === interfaceId);
  return entry === undefined
    ? null
    : {
        role,
        interface_id: interfaceId,
        interfaceKind: entry.kind,
        basePath: entry.base_path,
      };
}

function realRows(record: BundleRecord): CoverageRowRecord[] {
  return record.features.map((feature) => ({
    feature_id: feature.feature_id,
    area: feature.area,
    title: firstSentence(feature.description),
  }));
}

function roleIdsOf(record: BundleRecord, featureRoles: readonly string[]): readonly string[] {
  const everyRole = record.roles.map((role) => role.id);
  return featureRoles.includes("all") ? everyRole : featureRoles;
}

function emptyDataset(
  targetId: string,
  bundleId: string,
  bundleVersion: number,
): CoverageDataset {
  return { targetId, bundleId, bundleVersion, rows: [], columns: [], cells: [] };
}

function bundleDataset(record: BundleRecord, targetId: string): CoverageDataset {
  const bundleId = record.bundle.id;
  const dataset = emptyDataset(targetId, bundleId, record.bundle.version);
  const columnKeys = new Set<string>();
  const columns: CoverageColumnRecord[] = [];
  for (const feature of record.features) {
    const title = firstSentence(feature.description);
    for (const role of roleIdsOf(record, feature.roles)) {
      for (const interfaceId of feature.interface_ids) {
        const column = columnOf(record, role, interfaceId);
        if (column === null) {
          continue;
        }
        const key = `${role}|${interfaceId}`;
        if (!columnKeys.has(key)) {
          columnKeys.add(key);
          columns.push(column);
        }
        dataset.cells.push(
          buildCell({
            targetId,
            bundleId,
            featureId: feature.feature_id,
            area: feature.area,
            title,
            column,
          }),
        );
      }
    }
  }
  dataset.rows = realRows(record);
  dataset.columns = columns;
  return dataset;
}

function paddedDataset(record: BundleRecord, targetId: string): CoverageDataset {
  const bundleId = record.bundle.id;
  const dataset = emptyDataset(targetId, bundleId, record.bundle.version);
  const columns = PADDED_COLUMNS.flatMap((entry) => {
    const column = columnOf(record, entry.role, entry.interfaceId);
    return column === null ? [] : [column];
  });
  const rows = realRows(record);
  for (const feature of record.features) {
    const title = firstSentence(feature.description);
    const featureRoles = roleIdsOf(record, feature.roles);
    for (const column of columns) {
      if (featureRoles.includes(column.role) && feature.interface_ids.includes(column.interface_id)) {
        dataset.cells.push(
          buildCell({
            targetId,
            bundleId,
            featureId: feature.feature_id,
            area: feature.area,
            title,
            column,
          }),
        );
      }
    }
  }
  const missing = Math.max(0, PADDED_FEATURE_COUNT - rows.length);
  for (const line of PADDED_FEATURES.slice(0, missing)) {
    const [area = "", featureId = "", title = ""] = line.split("|");
    rows.push({ feature_id: featureId, area, title });
    const picked = columns.filter(
      (column, index) =>
        stableUnit("coverage_column", featureId, index) < COLUMN_PICK_THRESHOLD,
    );
    const chosen = picked.length >= MIN_PADDED_CELLS ? picked : columns.slice(0, MIN_PADDED_CELLS);
    for (const column of chosen) {
      dataset.cells.push(buildCell({ targetId, bundleId, featureId, area, title, column }));
    }
  }
  dataset.rows = groupedByArea(rows);
  dataset.columns = columns;
  return dataset;
}

function groupedByArea(rows: readonly CoverageRowRecord[]): CoverageRowRecord[] {
  const order = new Map<string, number>();
  for (const row of rows) {
    if (!order.has(row.area)) {
      order.set(row.area, order.size);
    }
  }
  return [...rows].sort((left, right) => (order.get(left.area) ?? 0) - (order.get(right.area) ?? 0));
}

export function buildCoverageDataset(
  record: BundleRecord,
  targetId: string,
  seed: CoverageSeed,
): CoverageDataset {
  if (seed === "empty") {
    return emptyDataset(targetId, record.bundle.id, record.bundle.version);
  }
  if (seed === "large" && isPaddable(record)) {
    return paddedDataset(record, targetId);
  }
  return bundleDataset(record, targetId);
}

export function areaSlug(area: string): string {
  return slugify(area);
}
