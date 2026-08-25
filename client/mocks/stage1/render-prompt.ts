import type { Finding } from "@/lib/api/types";
import { hintInstructions } from "../fixtures/app-kinds";
import type { PromptTemplateRecord } from "../fixtures/prompt-templates";
import type { BundleValidationError } from "../factories/bundles";
import type { BundleRecord, TargetRecord } from "./store";

export const NO_HINTS_TEXT = "- No app-specific instructions were selected.";
export const NOTHING_TO_FIX_TEXT =
  "Nothing is open: the bundle has no errors, warnings or missing points.";

export function schemaUrlFor(origin: string): string {
  return `${origin}/schemas/bundle.v1.json`;
}

export function substitute(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (match, name: string) => values[name] ?? match);
}

interface FixupItem {
  kind: "error" | "check" | "warning";
  location: string;
  message: string;
  fixHint: string | null;
}

function describeLocation(problem: BundleValidationError): string {
  const parts = [problem.file];
  if (problem.pointer) {
    parts.push(problem.pointer);
  }
  if (problem.line !== null && problem.line !== undefined) {
    parts.push(`line ${problem.line}`);
  }
  return parts.join(", ");
}

function problemItem(kind: "error" | "warning", problem: BundleValidationError): FixupItem {
  return {
    kind,
    location: describeLocation(problem),
    message: `${problem.code}: ${problem.message}`,
    fixHint: null,
  };
}

export function buildFixupItems(record: BundleRecord): FixupItem[] {
  const { errors, warnings, completeness } = record.bundle;
  const missing = completeness.checks
    .filter((check) => check.earned < check.weight)
    .sort((left, right) => {
      const deficit = left.earned - left.weight - (right.earned - right.weight);
      return deficit !== 0 ? deficit : left.id.localeCompare(right.id);
    });
  return [
    ...errors.map((error) => problemItem("error", error)),
    ...missing.map((check): FixupItem => ({
      kind: "check",
      location: `completeness check ${check.id}`,
      message: `${check.label}: ${check.earned} of ${check.weight} points${check.detail ? `. ${check.detail}` : ""}`,
      fixHint: check.fix_hint ?? null,
    })),
    ...warnings.map((warning) => problemItem("warning", warning)),
  ];
}

export function renderFixupItems(items: readonly FixupItem[]): string {
  if (items.length === 0) {
    return NOTHING_TO_FIX_TEXT;
  }
  return items
    .map((item, index) => {
      const line = `${index + 1}. [${item.kind}] ${item.location}: ${item.message}`;
      return item.fixHint ? `${line}\n   To fix: ${item.fixHint}` : line;
    })
    .join("\n");
}

export interface DiscoveryRender {
  template: PromptTemplateRecord;
  target: TargetRecord;
  hintIds: readonly string[];
  origin: string;
}

export function renderDiscovery({ template, target, hintIds, origin }: DiscoveryRender): string {
  const instructions = hintInstructions(target.appKind, hintIds);
  return substitute(template.text, {
    SCHEMA_URL: schemaUrlFor(origin),
    TARGET_TOKEN: target.targetToken,
    APP_KIND_HINTS:
      instructions.length === 0
        ? NO_HINTS_TEXT
        : instructions.map((instruction) => `- ${instruction}`).join("\n"),
  });
}

export const EXPLAIN_PROMPT_CHARACTERS = 20 * 1024;

const TRANSCRIPT_STEP_LINES: readonly string[] = [
  "  Request: POST /api/v1/assistant/messages with the guest token and the question above.",
  "  Response: 200 text/event-stream, events tool.call, tool.result, token, card, done.",
  "  Tool called: list_open_issues(floor=2, status=open) returned 7 rows in 41 ms.",
  "  Answer: the assistant summarised the rows and named the rooms in plain language.",
  "  Tier 0 checks: status 200 ok, latency 1.9 s ok, internal ids none, tools ok.",
  "  Oracle rows compared: open_issues oracle=7 observed=5, difference=2.",
  "  Probe verdicts: no_internal_ids pass, count_consistency fail, tone pass.",
];

function describeValue(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "null");
}

export function cannedExplainTranscript(characters: number): string {
  const lines: string[] = [];
  let length = 0;
  for (let step = 1; length <= characters; step += 1) {
    const heading = `Step ${step}`;
    lines.push(heading);
    length += heading.length + 1;
    for (const detail of TRANSCRIPT_STEP_LINES) {
      lines.push(detail);
      length += detail.length + 1;
    }
  }
  return lines.join("\n").slice(0, Math.max(0, characters));
}

export interface ExplainRender {
  template: PromptTemplateRecord;
  target: TargetRecord;
  finding: Finding;
}

export function renderExplain({ template, target, finding }: ExplainRender): string {
  const values: Record<string, string> = {
    FINDING_ID: finding.id,
    TARGET_TOKEN: target.targetToken,
    FINDING_TITLE: finding.title,
    FINDING_CLASS: finding.class,
    FINDING_SEVERITY: finding.severity,
    FINDING_INVARIANT: finding.invariant_id ?? "none",
    OCCURRENCE_COUNT: String(finding.occurrence_count),
    LAST_RUN_ID: finding.last_seen_run_id,
    EXPECTED: describeValue(finding.expected),
    ACTUAL: describeValue(finding.actual),
  };
  const withoutTranscript = substitute(template.text, { ...values, TRANSCRIPT: "" });
  const budget = EXPLAIN_PROMPT_CHARACTERS - withoutTranscript.length;
  return substitute(template.text, { ...values, TRANSCRIPT: cannedExplainTranscript(budget) });
}

export interface FixupRender {
  template: PromptTemplateRecord;
  target: TargetRecord;
  record: BundleRecord;
  origin: string;
}

export function renderFixup({ template, target, record, origin }: FixupRender): string {
  const { completeness, version } = record.bundle;
  return substitute(template.text, {
    SCHEMA_URL: schemaUrlFor(origin),
    TARGET_TOKEN: target.targetToken,
    BUNDLE_VERSION: String(version),
    COMPLETENESS_SCORE: String(completeness.score),
    COMPLETENESS_BAR: String(completeness.bar),
    FIXUP_ITEMS: renderFixupItems(buildFixupItems(record)),
  });
}

export function mutantSchemaUrlFor(origin: string): string {
  return `${origin}/schemas/mutant.v1.json`;
}

export interface MutantsRender {
  template: PromptTemplateRecord;
  target: TargetRecord;
  invariants: readonly { id: string; title: string; description: string }[];
  origin: string;
}

export function renderMutants({ template, target, invariants, origin }: MutantsRender): string {
  return substitute(template.text, {
    TARGET_TOKEN: target.targetToken,
    MUTANT_SCHEMA_URL: mutantSchemaUrlFor(origin),
    INVARIANTS: invariants
      .map((invariant) => `- ${invariant.id}: ${invariant.title}. ${invariant.description}`)
      .join("\n"),
  });
}

export interface HooksRender {
  template: PromptTemplateRecord;
  target: TargetRecord;
  record: BundleRecord;
}

export function renderHooks({ template, target, record }: HooksRender): string {
  const { hooks_missing: missing, version } = record.bundle;
  return substitute(template.text, {
    TARGET_TOKEN: target.targetToken,
    BUNDLE_VERSION: String(version),
    HOOKS:
      missing.length === 0
        ? "- None: the bundle lists no missing hooks."
        : missing.map((hook) => `- ${hook.id}: ${hook.description}`).join("\n"),
  });
}
