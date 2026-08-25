import type { Explanation, ExplanationOpinion, ExplanationStructured } from "@/lib/api/types";
import { MEMBER_USER } from "../factories/users";
import { stableId, stableInt } from "../stage2/ids";

export type ExplanationVariant = "none" | "text" | "structured" | "both";

const VARIANTS: readonly ExplanationVariant[] = ["none", "text", "structured", "both"];
const OPINIONS: readonly ExplanationOpinion[] = ["app_bug", "scenario_bug", "harness", "unknown"];
const HOUR_MS = 3_600_000;
const LONG_FILE_LIST_ONE_IN = 3;

const SOURCE_FILES = [
  { path: "src/billing/invoice_totals.py", lines: "88-112" },
  { path: "src/billing/rounding.py", lines: "14" },
  { path: "src/api/routes/invoices.py", lines: "203-219" },
  { path: "src/api/serializers/invoice.py", lines: "41" },
  { path: "src/tenants/scoping.py", lines: "57-71" },
  { path: "tests/billing/test_invoice_totals.py", lines: null },
] as const;

export function explanationVariantOf(findingId: string): ExplanationVariant {
  return VARIANTS[stableInt(0, VARIANTS.length - 1, "explanation_variant", findingId)] ?? "none";
}

function buildStructured(findingId: string): ExplanationStructured {
  const opinion =
    OPINIONS[stableInt(0, OPINIONS.length - 1, "explanation_opinion", findingId)] ?? "unknown";
  const long = stableInt(0, LONG_FILE_LIST_ONE_IN - 1, "explanation_long_files", findingId) === 0;
  const files: ExplanationStructured["files"] = long
    ? Array.from({ length: 16 }, (_, index) => ({
        path: `src/modules/module_${index + 1}/handlers/handler_${index + 1}.py`,
        lines: index % 3 === 0 ? null : `${10 + index}-${30 + index}`,
      }))
    : SOURCE_FILES.slice(0, stableInt(1, SOURCE_FILES.length, "explanation_files", findingId)).map(
        (file) => ({
          ...file,
        }),
      );
  const withCommit = stableInt(0, 1, "explanation_commit", findingId) === 0;
  return {
    opinion,
    root_cause:
      opinion === "app_bug"
        ? "The invoice total is rounded per line item before the tax is added, so a tenant with many small lines is off by a few cents. The rounding belongs after the sum."
        : opinion === "scenario_bug"
          ? "The scenario asserts a total computed with a different tax rate than the seed uses, so the expectation is wrong and the app is right."
          : opinion === "harness"
            ? "The environment reset ran after the seed finished, so the scenario started on an empty table. The app was not involved."
            : "The evidence does not separate an app fault from a stale seed. A repro on a clean database would tell.",
    files,
    commit: withCommit
      ? stableId("explanation_commit", findingId).replaceAll("-", "").slice(0, 40)
      : null,
    fix_branch: withCommit ? `fix/${opinion.replace("_", "-")}-${findingId.slice(-6)}` : null,
    confidence:
      (["low", "medium", "high"] as const)[stableInt(0, 2, "explanation_confidence", findingId)] ??
      "medium",
  };
}

function buildText(
  findingId: string,
  lastSeenAt: string,
  structured: boolean,
  offsetHours: number,
): Explanation {
  return {
    id: stableId("explanation", findingId, structured ? "structured" : "text"),
    finding_id: findingId,
    text: structured
      ? "Summary of the structured answer above. The relevant code is in src/billing/invoice_totals.py:88-112."
      : "The total is computed in src/billing/invoice_totals.py:88 and rounded per line in src/billing/rounding.py:14. Fix: round once after the sum.",
    source: "claude_code",
    created_by: MEMBER_USER.id,
    created_at: new Date(Date.parse(lastSeenAt) + offsetHours * HOUR_MS).toISOString(),
    ...(structured ? { structured: buildStructured(findingId) } : {}),
  };
}

export function buildSeededExplanations(
  finding: { id: string; last_seen_at: string },
  structuredEnabled: boolean,
): Explanation[] {
  const variant = explanationVariantOf(finding.id);
  if (variant === "none") {
    return [];
  }
  const text = buildText(finding.id, finding.last_seen_at, false, 1);
  if (!structuredEnabled || variant === "text") {
    return [text];
  }
  const structured = buildText(finding.id, finding.last_seen_at, true, 2);
  return variant === "both" ? [text, structured] : [{ ...structured, created_at: text.created_at }];
}
