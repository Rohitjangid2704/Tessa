export const CRITERION_PREFIXES = ["db", "tool", "text", "judge"] as const;

export type CriterionPrefix = (typeof CRITERION_PREFIXES)[number];

export type CriterionDecider = "code" | "judge";

export interface CriterionKindInfo {
  prefix: CriterionPrefix;
  label: string;
  decidedBy: CriterionDecider;
  hint: string;
  placeholder: string;
}

export const CRITERION_KINDS: readonly CriterionKindInfo[] = [
  {
    prefix: "db",
    label: "Database",
    decidedBy: "code",
    hint: "An end-state expectation, checked by code against the truth source.",
    placeholder: "guest_requests has one open maintenance row for room 412",
  },
  {
    prefix: "tool",
    label: "Tool call",
    decidedBy: "code",
    hint: "A tool call the app must make, checked by code.",
    placeholder: "create_service_request was called once",
  },
  {
    prefix: "text",
    label: "Text",
    decidedBy: "code",
    hint: "A substring or pattern the reply must contain, checked by code.",
    placeholder: "request number",
  },
  {
    prefix: "judge",
    label: "Judge",
    decidedBy: "judge",
    hint: "A plain-language criterion decided by the judge from the evidence. No prefix means this.",
    placeholder: "the assistant says when maintenance will come",
  },
];

export const DEFAULT_CRITERION_PREFIX: CriterionPrefix = "judge";

export interface ParsedCriterion {
  prefix: CriterionPrefix;
  text: string;
  explicit: boolean;
}

export function infoOfPrefix(prefix: CriterionPrefix): CriterionKindInfo {
  return (
    CRITERION_KINDS.find((kind) => kind.prefix === prefix) ??
    (CRITERION_KINDS.at(-1) as CriterionKindInfo)
  );
}

export function parseCriterion(entry: string): ParsedCriterion {
  for (const prefix of CRITERION_PREFIXES) {
    const marker = `${prefix}:`;
    if (entry.startsWith(marker)) {
      return { prefix, text: entry.slice(marker.length).trimStart(), explicit: true };
    }
  }
  return { prefix: DEFAULT_CRITERION_PREFIX, text: entry, explicit: false };
}

export function formatCriterion(prefix: CriterionPrefix, text: string): string {
  return `${prefix}:${text.length === 0 ? "" : ` ${text}`}`;
}

export function decidedByOf(entry: string): CriterionDecider {
  return infoOfPrefix(parseCriterion(entry).prefix).decidedBy;
}

export function isCompleteCriterion(entry: string): boolean {
  return parseCriterion(entry).text.trim() !== "";
}
