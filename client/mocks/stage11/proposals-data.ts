import type {
  Confidence,
  Depth,
  Proposal,
  ProposalItem,
  ProposalItemReason,
  ProposalKind,
  ProposalNeed,
  ProposalReason,
  ProposalRisk,
} from "@/lib/api/types";
import { stableId, stableInt, stableUnit } from "../stage2/ids";

export const PROPOSAL_VARIANTS = ["default", "empty", "stale", "large"] as const;

export type ProposalsVariant = (typeof PROPOSAL_VARIANTS)[number];

export const PROPOSAL_DEFAULT_ITEMS = 60;
export const PROPOSAL_LARGE_ITEMS = 200;
export const PROPOSAL_NOTE_MAX = 300;
export const PROPOSAL_TITLE_MAX = 120;
export const PROPOSAL_EVIDENCE_MAX = 500;
export const PROPOSAL_YAML_MAX_BYTES = 256 * 1024;
export const PROPOSAL_ITEMS_MAX = 200;

export const PROPOSAL_KINDS: readonly ProposalKind[] = [
  "api",
  "browser",
  "stream",
  "webhook",
  "pipeline",
  "contract",
  "integration",
];

export const PROPOSAL_RISKS: readonly ProposalRisk[] = ["high", "medium", "low"];

export const PROPOSAL_REASONS: readonly ProposalReason[] = [
  "recent_change",
  "no_unit_tests",
  "auth_path",
  "money_path",
  "migration",
  "complexity",
  "bug_history",
  "external_dependency",
  "user_visible",
];

export const PROPOSAL_NEEDS: readonly ProposalNeed[] = [
  "seed",
  "db_read",
  "hook",
  "flag",
  "fixture",
  "credentials",
];

export const PROPOSAL_DEPTHS: readonly Depth[] = ["smoke", "standard", "deep"];

export const PROPOSAL_CONFIDENCES: readonly Confidence[] = ["low", "medium", "high"];

export const PROPOSAL_CHOICES = ["proposed", "selected", "declined"] as const;

export type ProposalChoice = (typeof PROPOSAL_CHOICES)[number];

export type StoredItemStatus = ProposalChoice | "authored";

export type ProposalItemRecord = Omit<ProposalItem, "cell_ids" | "status"> & {
  status: StoredItemStatus;
};

export type ProposalRecord = Omit<Proposal, "items" | "stale"> & {
  items: ProposalItemRecord[];
};

export interface FeatureSeed {
  featureId: string;
  area: string;
  title: string;
  interfaceIds: readonly string[];
}

interface Angle {
  slug: string;
  label: string;
}

const ANGLES: readonly Angle[] = [
  { slug: "core", label: "" },
  { slug: "permissions", label: "who may do it" },
  { slug: "errors", label: "bad input and failures" },
  { slug: "limits", label: "limits and edge values" },
];

const RISK_RANK: Readonly<Record<ProposalRisk, number>> = { high: 0, medium: 1, low: 2 };

const REASON_NOTES: Readonly<Record<ProposalReason, readonly string[]>> = {
  recent_change: [
    "{n} commits touched this module since the last release",
    "Rewritten in the last sprint, no test followed it",
  ],
  no_unit_tests: ["No unit test imports this module", "tests/ has nothing for this route"],
  auth_path: ["Guarded by the role check in the auth middleware", "Reads the session token"],
  money_path: ["Posts to the ledger", "Changes a folio balance"],
  migration: ["Schema changed in migration 0{n}", "A backfill runs on deploy"],
  complexity: ["{n} branches in one handler", "Nested retries around an external call"],
  bug_history: ["{n} bug fixes in the last 90 days", "Reopened twice after a release"],
  external_dependency: ["Calls the property management system", "Depends on the mail gateway"],
  user_visible: ["Shown on the front desk dashboard", "The first thing a guest sees"],
};

const EVIDENCE_PATHS: readonly string[] = [
  "src/{area}/handlers.py",
  "src/{area}/service.py",
  "app/routes/{area}.ts",
  "db/migrations/00{n}_{area}.sql",
];

const DECLINE_NOTES: readonly string[] = [
  "Out of scope for this release",
  "Covered by the vendor contract tests",
  "Planned for the next quarter",
];

const AREA_RISK_BIAS: readonly string[] = ["billing", "account", "access"];

function slugOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function kindOfFeature(feature: FeatureSeed): ProposalKind {
  const segments = feature.featureId.split(".");
  const type = segments[1] ?? "read";
  if (type === "stream") {
    return "stream";
  }
  if (type === "job") {
    return "pipeline";
  }
  if (type === "flow") {
    return "browser";
  }
  const roll = stableUnit("proposal_kind", feature.featureId);
  if (roll > 0.94) {
    return "webhook";
  }
  if (roll > 0.88) {
    return "contract";
  }
  if (roll > 0.8) {
    return "integration";
  }
  return type === "read" && roll < 0.2 ? "browser" : "api";
}

function riskOfFeature(feature: FeatureSeed, angle: number): ProposalRisk {
  const type = feature.featureId.split(".")[1] ?? "read";
  const biased =
    AREA_RISK_BIAS.some((area) => feature.featureId.startsWith(area)) ||
    type === "write" ||
    type === "admin" ||
    type === "auth";
  const roll = stableUnit("proposal_risk", feature.featureId, angle);
  if (biased ? roll < 0.6 : roll < 0.15) {
    return "high";
  }
  return roll < 0.7 ? "medium" : "low";
}

function pickReasons(feature: FeatureSeed, angle: number): ProposalItemReason[] {
  const count = stableInt(1, 3, "proposal_reason_count", feature.featureId, angle);
  const chosen: ProposalReason[] = [];
  for (let attempt = 0; chosen.length < count && attempt < 40; attempt += 1) {
    const code =
      PROPOSAL_REASONS[
        stableInt(
          0,
          PROPOSAL_REASONS.length - 1,
          "proposal_reason",
          feature.featureId,
          angle,
          attempt,
        )
      ];
    if (code !== undefined && !chosen.includes(code)) {
      chosen.push(code);
    }
  }
  return chosen.map((code, index) => {
    if (stableUnit("proposal_reason_note", feature.featureId, angle, index) < 0.25) {
      return { code };
    }
    const notes = REASON_NOTES[code];
    const template =
      notes[stableInt(0, notes.length - 1, "proposal_note", feature.featureId, angle, code)] ?? "";
    const note = template.replace(
      "{n}",
      String(stableInt(2, 9, "proposal_note_n", feature.featureId, angle, code)),
    );
    return { code, note };
  });
}

function pickNeeds(feature: FeatureSeed, angle: number, kind: ProposalKind): ProposalNeed[] {
  const needs = PROPOSAL_NEEDS.filter(
    (need, index) => stableUnit("proposal_need", feature.featureId, angle, index) < 0.22,
  );
  if (kind === "browser" && !needs.includes("credentials")) {
    needs.push("credentials");
  }
  return needs.slice(0, 4);
}

function evidenceOf(feature: FeatureSeed, angle: number): string | null {
  if (stableUnit("proposal_evidence", feature.featureId, angle) < 0.2) {
    return null;
  }
  const area = slugOf(feature.area).replaceAll("-", "_");
  const paths = [0, 1].map((slot) => {
    const template =
      EVIDENCE_PATHS[
        stableInt(0, EVIDENCE_PATHS.length - 1, "proposal_path", feature.featureId, angle, slot)
      ] ?? "";
    return template
      .replace("{area}", area)
      .replace("{n}", String(stableInt(10, 48, "proposal_path_n", feature.featureId, angle)));
  });
  return `${paths[0]}, ${paths[1]}`;
}

function depthOf(risk: ProposalRisk): Depth {
  if (risk === "high") {
    return "deep";
  }
  return risk === "medium" ? "standard" : "smoke";
}

function confidenceOf(feature: FeatureSeed, angle: number): Confidence {
  const roll = stableUnit("proposal_confidence", feature.featureId, angle);
  if (roll < 0.15) {
    return "low";
  }
  return roll < 0.55 ? "medium" : "high";
}

function estimateOf(feature: FeatureSeed, angle: number, risk: ProposalRisk) {
  if (stableUnit("proposal_estimate", feature.featureId, angle) < 0.12) {
    return null;
  }
  const scenarios = stableInt(
    1,
    risk === "high" ? 6 : 3,
    "proposal_estimate_n",
    feature.featureId,
    angle,
  );
  return { scenarios, minutes: Math.max(1, Math.round(scenarios * 1.5)) };
}

export interface SeedContext {
  features: readonly FeatureSeed[];
  count: number;
  createdBy: string;
  selectedBy: string;
  selectedAtBase: number;
}

export function buildSeedItems(context: SeedContext): ProposalItemRecord[] {
  const { features, count } = context;
  if (features.length === 0) {
    return [];
  }
  const items: ProposalItemRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const feature = features[index % features.length];
    if (feature === undefined) {
      continue;
    }
    const round = Math.floor(index / features.length);
    const angle = ANGLES[round % ANGLES.length] ?? ANGLES[0];
    if (angle === undefined) {
      continue;
    }
    const repeat = Math.floor(round / ANGLES.length);
    const slug = slugOf(feature.featureId.replaceAll(".", "-"));
    const key = `${slug}-${angle.slug}${repeat === 0 ? "" : `-${repeat + 1}`}`;
    const kind = kindOfFeature(feature);
    const risk = riskOfFeature(feature, round);
    const title = `${feature.title}${angle.label === "" ? "" : `: ${angle.label}`}`;
    const interfaceId =
      round === 0 || feature.interfaceIds.length === 0
        ? null
        : (feature.interfaceIds[round % feature.interfaceIds.length] ?? null);
    const roll = stableUnit("proposal_status", key);
    const declined = roll >= 0.06 && roll < 0.1;
    const selected = roll < 0.06;
    const authored = roll >= 0.1 && roll < 0.13;
    const status: StoredItemStatus = selected
      ? "selected"
      : declined
        ? "declined"
        : authored
          ? "authored"
          : "proposed";
    const moved = selected || declined;
    items.push({
      id: stableId("proposal_item", key),
      key,
      title: title.slice(0, PROPOSAL_TITLE_MAX),
      area: feature.area,
      feature_ids: [feature.featureId],
      interface_id: interfaceId,
      kind,
      risk,
      reasons: pickReasons(feature, round),
      needs: pickNeeds(feature, round, kind),
      depth: depthOf(risk),
      estimate: estimateOf(feature, round, risk),
      confidence: confidenceOf(feature, round),
      evidence: evidenceOf(feature, round),
      status,
      note: declined
        ? (DECLINE_NOTES[stableInt(0, DECLINE_NOTES.length - 1, "proposal_decline", key)] ?? null)
        : null,
      selected_by: moved ? context.selectedBy : null,
      selected_at: moved
        ? new Date(
            context.selectedAtBase - stableInt(1, 300, "proposal_selected_at", key) * 60_000,
          ).toISOString()
        : null,
      scenario_ids: [],
    });
  }
  return items.sort(
    (left, right) =>
      RISK_RANK[left.risk] - RISK_RANK[right.risk] || left.key.localeCompare(right.key),
  );
}
