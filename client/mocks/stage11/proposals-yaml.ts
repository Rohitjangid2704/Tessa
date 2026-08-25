import { LineCounter, parseDocument, type Document } from "yaml";
import type {
  Confidence,
  Depth,
  ProposalKind,
  ProposalNeed,
  ProposalReason,
  ProposalRisk,
} from "@/lib/api/types";
import type { ErrorDetail } from "../types";
import {
  PROPOSAL_CONFIDENCES,
  PROPOSAL_DEPTHS,
  PROPOSAL_EVIDENCE_MAX,
  PROPOSAL_ITEMS_MAX,
  PROPOSAL_KINDS,
  PROPOSAL_NEEDS,
  PROPOSAL_NOTE_MAX,
  PROPOSAL_REASONS,
  PROPOSAL_RISKS,
  PROPOSAL_TITLE_MAX,
} from "./proposals-data";

export interface DocItem {
  key: string;
  title: string;
  area: string;
  feature_ids: string[];
  interface_id: string | null;
  kind: ProposalKind;
  risk: ProposalRisk;
  reasons: Array<{ code: ProposalReason; note?: string | null }>;
  needs: ProposalNeed[];
  depth: Depth;
  estimate: { scenarios: number; minutes: number } | null;
  confidence: Confidence;
  evidence: string | null;
}

export interface ProposalDocCheck {
  errors: ErrorDetail[];
  items: DocItem[];
  generatedAt: string | null;
  commit: string | null;
  branch: string | null;
  lowConfidenceKeys: Set<string>;
}

export interface CheckContext {
  targetTokens: readonly string[];
  featureIds: ReadonlySet<string>;
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9_.-]{2,79}$/;
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const SCHEMA_PATTERN = /^https?:\/\/[^\s/]+(\/\S*)?\/schemas\/proposal\.v1\.json$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;
const TOP_LEVEL_KEYS = new Set([
  "schema",
  "target_token",
  "generated_at",
  "source",
  "authored_from",
  "items",
]);
const ITEM_KEYS = new Set([
  "key",
  "title",
  "area",
  "feature_ids",
  "interface_id",
  "kind",
  "risk",
  "reasons",
  "needs",
  "depth",
  "estimate",
  "confidence",
  "evidence",
]);

type Pointer = ReadonlyArray<string | number>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function includes<Value extends string>(
  allowed: readonly Value[],
  candidate: unknown,
): candidate is Value {
  return typeof candidate === "string" && allowed.some((entry) => entry === candidate);
}

class Reporter {
  readonly errors: ErrorDetail[] = [];
  private readonly document: Document.Parsed;
  private readonly lines: LineCounter;

  constructor(document: Document.Parsed, lines: LineCounter) {
    this.document = document;
    this.lines = lines;
  }

  at(pointer: Pointer, code: string, message: string): void {
    const node: unknown = this.document.getIn(pointer, true);
    const range = isRecord(node) && Array.isArray(node.range) ? node.range : undefined;
    const offset = range !== undefined && typeof range[0] === "number" ? range[0] : undefined;
    const line = offset === undefined ? undefined : this.lines.linePos(offset).line;
    const text = pointer.length === 0 ? "" : `/${pointer.join("/")}`;
    this.errors.push({
      loc: text === "" ? ["body", "yaml"] : ["body", "yaml", text],
      code,
      message: line === undefined ? message : `line ${line}: ${message}`,
    });
  }
}

function checkString(
  reporter: Reporter,
  source: Record<string, unknown>,
  field: string,
  base: Pointer,
  rules: { required: boolean; max: number },
): string | null {
  const value = source[field];
  if (value === undefined || value === null) {
    if (rules.required) {
      reporter.at([...base, field], "missing", "Field required");
    }
    return null;
  }
  if (typeof value !== "string") {
    reporter.at([...base, field], "string_type", "Input should be a valid string");
    return null;
  }
  if (value.length === 0 && rules.required) {
    reporter.at([...base, field], "string_too_short", "String should have at least 1 character");
    return null;
  }
  if (value.length > rules.max) {
    reporter.at(
      [...base, field],
      "string_too_long",
      `String should have at most ${rules.max} characters`,
    );
    return null;
  }
  return value;
}

function checkEnum<Value extends string>(
  reporter: Reporter,
  source: Record<string, unknown>,
  field: string,
  base: Pointer,
  allowed: readonly Value[],
): Value | null {
  const value = source[field];
  if (value === undefined) {
    reporter.at([...base, field], "missing", "Field required");
    return null;
  }
  if (!includes(allowed, value)) {
    reporter.at(
      [...base, field],
      "enum",
      `Input should be ${allowed.map((entry) => `'${entry}'`).join(", ")}`,
    );
    return null;
  }
  return value;
}

function checkExtraKeys(
  reporter: Reporter,
  source: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  base: Pointer,
): void {
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) {
      reporter.at([...base, key], "extra_forbidden", "Extra inputs are not permitted");
    }
  }
}

function checkReasons(reporter: Reporter, raw: unknown, base: Pointer): DocItem["reasons"] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 6) {
    reporter.at(
      [...base, "reasons"],
      Array.isArray(raw) && raw.length > 6 ? "too_long" : "too_short",
      "List should have between 1 and 6 reasons",
    );
    return [];
  }
  const reasons: DocItem["reasons"] = [];
  const seen = new Set<string>();
  raw.forEach((entry: unknown, index) => {
    const at = [...base, "reasons", index];
    if (!isRecord(entry)) {
      reporter.at(at, "model_attributes_type", "Input should be a valid dictionary or object");
      return;
    }
    checkExtraKeys(reporter, entry, new Set(["code", "note"]), at);
    const code = checkEnum(reporter, entry, "code", at, PROPOSAL_REASONS);
    const note = checkString(reporter, entry, "note", at, {
      required: false,
      max: PROPOSAL_NOTE_MAX,
    });
    if (code === null) {
      return;
    }
    if (seen.has(code)) {
      reporter.at(at, "value_error", "each reason code appears at most once");
      return;
    }
    seen.add(code);
    reasons.push(note === null ? { code } : { code, note });
  });
  return reasons;
}

function checkNeeds(reporter: Reporter, raw: unknown, base: Pointer): ProposalNeed[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length > 6) {
    reporter.at([...base, "needs"], "list_type", "Input should be a list of at most 6 needs");
    return [];
  }
  const needs: ProposalNeed[] = [];
  raw.forEach((entry: unknown, index) => {
    if (!includes(PROPOSAL_NEEDS, entry)) {
      reporter.at([...base, "needs", index], "enum", "Input should be a known need");
    } else if (needs.includes(entry)) {
      reporter.at([...base, "needs"], "value_error", "each need appears at most once");
    } else {
      needs.push(entry);
    }
  });
  return needs;
}

function checkEstimate(reporter: Reporter, raw: unknown, base: Pointer): DocItem["estimate"] {
  if (raw === undefined || raw === null) {
    return null;
  }
  const at = [...base, "estimate"];
  if (!isRecord(raw)) {
    reporter.at(at, "model_attributes_type", "Input should be a valid dictionary or object");
    return null;
  }
  checkExtraKeys(reporter, raw, new Set(["scenarios", "minutes"]), at);
  const { scenarios, minutes } = raw;
  const scenariosOk =
    typeof scenarios === "number" &&
    Number.isInteger(scenarios) &&
    scenarios >= 1 &&
    scenarios <= 50;
  const minutesOk =
    typeof minutes === "number" && Number.isInteger(minutes) && minutes >= 1 && minutes <= 600;
  if (!scenariosOk) {
    reporter.at([...at, "scenarios"], "int_range", "scenarios must be an integer from 1 to 50");
  }
  if (!minutesOk) {
    reporter.at([...at, "minutes"], "int_range", "minutes must be an integer from 1 to 600");
  }
  return scenariosOk && minutesOk ? { scenarios, minutes } : null;
}

function checkFeatureIds(reporter: Reporter, raw: unknown, base: Pointer): string[] {
  const at = [...base, "feature_ids"];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) {
    reporter.at(at, "too_short", "List should have between 1 and 20 feature ids");
    return [];
  }
  const ids: string[] = [];
  raw.forEach((entry: unknown, index) => {
    if (typeof entry !== "string" || !SLUG_PATTERN.test(entry)) {
      reporter.at([...at, index], "string_pattern_mismatch", "String should be a slug");
    } else {
      ids.push(entry);
    }
  });
  return ids;
}

function checkItem(
  reporter: Reporter,
  raw: unknown,
  index: number,
  context: CheckContext,
  keys: Set<string>,
  lowConfidence: Set<string>,
): DocItem | null {
  const base: Pointer = ["items", index];
  if (!isRecord(raw)) {
    reporter.at(base, "model_attributes_type", "Input should be a valid dictionary or object");
    return null;
  }
  const before = reporter.errors.length;
  checkExtraKeys(reporter, raw, ITEM_KEYS, base);
  const key = checkString(reporter, raw, "key", base, { required: true, max: 80 });
  if (key !== null && !KEY_PATTERN.test(key)) {
    reporter.at(
      [...base, "key"],
      "string_pattern_mismatch",
      "String should be a slug of 3 to 80 characters",
    );
  } else if (key !== null && keys.has(key)) {
    reporter.at(
      [...base, "key"],
      "duplicate_proposal_key",
      `The key '${key}' is already used by another item`,
    );
  } else if (key !== null) {
    keys.add(key);
  }
  const title = checkString(reporter, raw, "title", base, {
    required: true,
    max: PROPOSAL_TITLE_MAX,
  });
  const area = checkString(reporter, raw, "area", base, { required: true, max: 120 });
  const featureIds = checkFeatureIds(reporter, raw.feature_ids, base);
  const interfaceId = checkString(reporter, raw, "interface_id", base, {
    required: false,
    max: 80,
  });
  const kind = checkEnum(reporter, raw, "kind", base, PROPOSAL_KINDS);
  const risk = checkEnum(reporter, raw, "risk", base, PROPOSAL_RISKS);
  const reasons = checkReasons(reporter, raw.reasons, base);
  const needs = checkNeeds(reporter, raw.needs, base);
  const depth = checkEnum(reporter, raw, "depth", base, PROPOSAL_DEPTHS);
  const estimate = checkEstimate(reporter, raw.estimate, base);
  const confidence = checkEnum(reporter, raw, "confidence", base, PROPOSAL_CONFIDENCES);
  const evidence = checkString(reporter, raw, "evidence", base, {
    required: false,
    max: PROPOSAL_EVIDENCE_MAX,
  });
  if (reporter.errors.length > before) {
    return null;
  }
  if (
    key === null ||
    title === null ||
    area === null ||
    kind === null ||
    risk === null ||
    depth === null ||
    confidence === null
  ) {
    return null;
  }
  const unknown = featureIds.some((featureId) => !context.featureIds.has(featureId));
  if (unknown) {
    lowConfidence.add(key);
  }
  return {
    key,
    title,
    area,
    feature_ids: featureIds,
    interface_id: interfaceId,
    kind,
    risk,
    reasons,
    needs,
    depth,
    estimate,
    confidence: unknown ? "low" : confidence,
    evidence,
  };
}

function syntaxError(message: string, line: number | undefined): ProposalDocCheck {
  return {
    errors: [
      {
        loc: ["body", "yaml"],
        code: "yaml_syntax",
        message: line === undefined ? message : `line ${line}: ${message}`,
      },
    ],
    items: [],
    generatedAt: null,
    commit: null,
    branch: null,
    lowConfidenceKeys: new Set(),
  };
}

export function checkProposalYaml(text: string, context: CheckContext): ProposalDocCheck {
  const lines = new LineCounter();
  const document = parseDocument(text, { lineCounter: lines, prettyErrors: false });
  const first = document.errors[0];
  if (first !== undefined) {
    const line = first.linePos?.[0]?.line;
    return syntaxError(first.message.split("\n")[0] ?? "Invalid YAML", line);
  }
  const reporter = new Reporter(document, lines);
  const root: unknown = document.toJS();
  const empty: ProposalDocCheck = {
    errors: reporter.errors,
    items: [],
    generatedAt: null,
    commit: null,
    branch: null,
    lowConfidenceKeys: new Set(),
  };
  if (!isRecord(root)) {
    reporter.at([], "model_attributes_type", "The document must be a mapping");
    return empty;
  }
  checkExtraKeys(reporter, root, TOP_LEVEL_KEYS, []);
  const schema = checkString(reporter, root, "schema", [], { required: true, max: 400 });
  if (schema !== null && !SCHEMA_PATTERN.test(schema)) {
    reporter.at(
      ["schema"],
      "string_pattern_mismatch",
      "schema must be the URL of proposal.v1.json",
    );
  }
  const token = checkString(reporter, root, "target_token", [], { required: true, max: 64 });
  if (token !== null && context.targetTokens.length > 0 && !context.targetTokens.includes(token)) {
    reporter.at(
      ["target_token"],
      "proposal_target_mismatch",
      "The target_token of the proposal belongs to a different target",
    );
  }
  const generatedRaw = root.generated_at;
  let generatedAt: string | null = null;
  if (generatedRaw !== undefined && generatedRaw !== null) {
    const asText = generatedRaw instanceof Date ? generatedRaw.toISOString() : String(generatedRaw);
    if (Number.isNaN(Date.parse(asText))) {
      reporter.at(["generated_at"], "datetime_parsing", "Input should be a valid datetime");
    } else {
      generatedAt = new Date(asText).toISOString();
    }
  }
  let commit: string | null = null;
  let branch: string | null = null;
  const source = root.source;
  if (source !== undefined && source !== null) {
    if (!isRecord(source)) {
      reporter.at(
        ["source"],
        "model_attributes_type",
        "Input should be a valid dictionary or object",
      );
    } else {
      const sourceCommit = source.commit;
      if (typeof sourceCommit !== "string" || !COMMIT_PATTERN.test(sourceCommit)) {
        reporter.at(
          ["source", "commit"],
          "string_pattern_mismatch",
          "commit must be 7 to 40 lowercase hex characters",
        );
      } else {
        commit = sourceCommit;
      }
      branch = typeof source.branch === "string" ? source.branch : null;
    }
  }
  const rawItems = root.items;
  const items: DocItem[] = [];
  const lowConfidenceKeys = new Set<string>();
  if (!Array.isArray(rawItems) || rawItems.length < 1) {
    reporter.at(["items"], "too_short", "List should have at least 1 item");
  } else if (rawItems.length > PROPOSAL_ITEMS_MAX) {
    reporter.at(["items"], "too_long", `List should have at most ${PROPOSAL_ITEMS_MAX} items`);
  } else {
    const keys = new Set<string>();
    rawItems.forEach((entry: unknown, index) => {
      const item = checkItem(reporter, entry, index, context, keys, lowConfidenceKeys);
      if (item !== null) {
        items.push(item);
      }
    });
  }
  return { errors: reporter.errors, items, generatedAt, commit, branch, lowConfidenceKeys };
}
