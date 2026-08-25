import type { Target, TargetSummary } from "../factories/targets";
import { allowJevOfTargetId } from "../stage10/jev-consent";
import { teamIdOfTargetId } from "../stage10/teams-store";
import { overallHealth } from "./health";
import type { EnvironmentEntry, StageOneStore, TargetRecord } from "./store";
import type { EnvironmentVariable } from "../factories/environment";
import type { TargetTeamFields } from "@/lib/api/types";

type TeamField = Pick<TargetTeamFields, "team_id" | "allow_jev">;

export function toTarget(store: StageOneStore, record: TargetRecord): Target & TeamField {
  return {
    team_id: teamIdOfTargetId(record.id),
    allow_jev: allowJevOfTargetId(record.id),
    id: record.id,
    name: record.name,
    slug: record.slug,
    app_kind: record.appKind,
    tier: record.tier,
    allow_production: record.allowProduction,
    target_token: record.targetToken,
    hints: { ...record.hints },
    latest_bundle_id: store.latestBundle(record.id)?.bundle.id ?? null,
    created_at: record.createdAt,
    archived_at: record.archivedAt,
  };
}

export function toTargetSummary(
  store: StageOneStore,
  record: TargetRecord,
): TargetSummary & TeamField {
  const latest = store.latestBundle(record.id);
  return {
    team_id: teamIdOfTargetId(record.id),
    allow_jev: allowJevOfTargetId(record.id),
    id: record.id,
    name: record.name,
    slug: record.slug,
    app_kind: record.appKind,
    tier: record.tier,
    latest_bundle_version: latest?.bundle.version ?? null,
    completeness_score: latest?.bundle.completeness.score ?? null,
    health: overallHealth(record.healthReport),
    created_at: record.createdAt,
    archived_at: record.archivedAt,
  };
}

export function toEnvironmentVariable(entry: EnvironmentEntry): EnvironmentVariable {
  return {
    name: entry.name,
    kind: entry.kind,
    secret: entry.secret,
    required: entry.required,
    purpose: entry.purpose,
    interface_ids: [...entry.interface_ids],
    has_value: entry.value !== null,
    value: entry.secret ? null : entry.value,
    stale: entry.stale,
    last_set_at: entry.last_set_at,
    last_set_by: entry.last_set_by,
    health: { ...entry.health },
  };
}
