import type { InterimSchemas } from "@/lib/api/interim";
import type { components } from "@/lib/api/schema";
import { newId } from "./ids";
import { nowIso } from "./targets";

type Schemas = components["schemas"];

export type Bundle = Schemas["Bundle"] & Partial<InterimSchemas["BundleSourceFields"]>;
export type BundleSummary = Schemas["BundleSummary"];
export type BundleSummaryPage = Schemas["BundleSummaryPage"];
export type BundleUploadResult = Schemas["BundleUploadResult"];
export type BundleCompleteness = Schemas["BundleCompleteness"];
export type BundleCompletenessCheck = Schemas["BundleCompletenessCheck"];
export type BundleValidationError = Schemas["BundleValidationError"];
export type BundleDiff = Schemas["BundleDiff"];
export type BundleFileList = Schemas["BundleFileList"];
export type BundleFileContent = Schemas["BundleFileContent"];

export const COMPLETENESS_BAR = 80;

export const COMPLETENESS_CHECK_DEFINITIONS = [
  { id: "required_sections", label: "Required manifest sections", weight: 20 },
  { id: "feature_interface_roles", label: "Features name interfaces and roles", weight: 15 },
  { id: "feature_examples", label: "Features carry concrete examples", weight: 20 },
  { id: "oracle_read_only", label: "Read-only oracle per computable feature", weight: 15 },
  { id: "env_template_coverage", label: "env.template covers every placeholder", weight: 15 },
  { id: "seeds_reset_and_hash", label: "Seeds with a reset script and a hash command", weight: 15 },
] as const;

export type CompletenessCheckId = (typeof COMPLETENESS_CHECK_DEFINITIONS)[number]["id"];

export interface CheckOutcome {
  earned: number;
  detail?: string | null;
  fix_hint?: string | null;
}

export function buildCompleteness(
  outcomes: Readonly<Record<CompletenessCheckId, CheckOutcome>>,
  bar: number = COMPLETENESS_BAR,
): BundleCompleteness {
  const checks: BundleCompletenessCheck[] = COMPLETENESS_CHECK_DEFINITIONS.map((definition) => {
    const outcome = outcomes[definition.id];
    return {
      id: definition.id,
      label: definition.label,
      passed: outcome.earned === definition.weight,
      weight: definition.weight,
      earned: outcome.earned,
      detail: outcome.detail ?? null,
      fix_hint: outcome.fix_hint ?? null,
    };
  });
  const score = checks.reduce((sum, check) => sum + check.earned, 0);
  return { score, bar, status: score >= bar ? "meets_bar" : "below_bar", checks };
}

export function buildValidationError(
  overrides: Partial<BundleValidationError> = {},
): BundleValidationError {
  return {
    code: "schema_violation",
    message: "Value is not valid",
    severity: "error",
    file: "manifest.yaml",
    pointer: null,
    line: null,
    column: null,
    ...overrides,
  };
}

export function buildBundle(overrides: Partial<Bundle> = {}): Bundle {
  return {
    id: newId(),
    target_id: newId(),
    version: 1,
    hash: "0".repeat(64),
    source: "zip",
    note: null,
    schema_version: 1,
    uploaded_by: newId(),
    uploaded_at: nowIso(),
    validation_status: "valid",
    errors: [],
    warnings: [],
    completeness: buildCompleteness({
      required_sections: { earned: 20 },
      feature_interface_roles: { earned: 15 },
      feature_examples: { earned: 20 },
      oracle_read_only: { earned: 15 },
      env_template_coverage: { earned: 15 },
      seeds_reset_and_hash: { earned: 15 },
    }),
    diff_summary: null,
    feature_count: 0,
    file_count: 0,
    size_bytes: 0,
    hooks_missing: [],
    scenarios_imported: 0,
    mutants_imported: 0,
    commit_sha: null,
    branch: null,
    ...overrides,
  };
}

export function toBundleSummary(bundle: Bundle): BundleSummary {
  return {
    id: bundle.id,
    version: bundle.version,
    hash: bundle.hash,
    source: bundle.source,
    validation_status: bundle.validation_status,
    completeness_score: bundle.completeness.score,
    completeness_status: bundle.completeness.status,
    feature_count: bundle.feature_count,
    uploaded_at: bundle.uploaded_at,
  };
}

export function buildBundleSummary(overrides: Partial<BundleSummary> = {}): BundleSummary {
  return { ...toBundleSummary(buildBundle()), ...overrides };
}

export function buildBundleSummaryPage(
  items: readonly BundleSummary[],
  overrides: Partial<Omit<BundleSummaryPage, "items">> = {},
): BundleSummaryPage {
  return { items: [...items], next_cursor: null, total: null, ...overrides };
}

export function buildBundleUploadResult(
  bundle: Bundle,
  overrides: Partial<Omit<BundleUploadResult, "bundle">> = {},
): BundleUploadResult {
  return { bundle, created: true, dry_run_run_id: null, ...overrides };
}
