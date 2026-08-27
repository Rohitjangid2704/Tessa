import { z } from "zod";
import { unwrap, unwrapOptional } from "../client";
import { cutList, cutValue } from "../cut";
import type { Schemas } from "../types";
import { asList } from "./args";
import { defineTool } from "./define";

const TRANSCRIPT_LIMIT = 40;
const TRANSCRIPT_TEXT_BYTES = 600;
const ORACLE_ROW_LIMIT = 20;
const SCREENCAST_LIMIT = 5;
const FINDING_VALUE_CUT_BYTES = 4000;
const SCENARIO_YAML_CUT_BYTES = 20_000;
export const EXPLANATION_TEXT_MAX_CHARS = 20_000;

const FINDING_STATUSES = ["new", "triaged", "in_fix", "verifying", "resolved", "known_gap", "dismissed"] as const;
const MOVABLE_STATUSES = ["new", "triaged", "in_fix", "verifying", "known_gap", "dismissed"] as const;
const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
const OPINIONS = ["app_bug", "scenario_bug", "harness", "unknown"] as const;
const CONFIDENCES = ["low", "medium", "high"] as const;
const LINE_RANGE = /^[0-9]{1,7}(-[0-9]{1,7})?$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const NO_WHITESPACE = /^\S+$/;
const UNSAFE_PATH = /(^|\/)\.\.(\/|$)|^\/|^~|^[A-Za-z]:|[\x00-\x1f]/;

function withForwardSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

function isRepositoryPath(path: string): boolean {
  return !UNSAFE_PATH.test(withForwardSlashes(path));
}

function isAscendingRange(lines: string): boolean {
  const [first, last] = lines.split("-");
  return last === undefined || Number(first) <= Number(last);
}

function isNotBlank(text: string): boolean {
  return text.trim().length > 0;
}

const structuredInput = z.object({
  opinion: z.enum(OPINIONS),
  root_cause: z.string().min(1).max(2000).refine(isNotBlank, "root_cause must not be blank"),
  files: z
    .array(
      z.object({
        path: z
          .string()
          .min(1)
          .max(300)
          .refine(isRepositoryPath, "path must be relative to the repository root and hold no .., ~ or drive letter"),
        lines: z
          .string()
          .regex(LINE_RANGE, "lines look like 12 or 12-40, at most 7 digits each")
          .refine(isAscendingRange, "lines must run from the smaller to the larger number")
          .optional(),
      }),
    )
    .max(30),
  commit: z.string().regex(COMMIT, "commit is 7 to 40 lowercase hex digits").optional(),
  fix_branch: z.string().min(1).max(200).regex(NO_WHITESPACE, "fix_branch holds no whitespace").optional(),
  confidence: z.enum(CONFIDENCES),
});

type StructuredInput = z.infer<typeof structuredInput>;

function structuredBody(structured: StructuredInput | undefined) {
  if (structured === undefined) {
    return null;
  }
  return {
    ...structured,
    files: structured.files.map((file) => ({ ...file, path: withForwardSlashes(file.path) })),
  };
}

export const listFindings = defineTool({
  name: "list_findings",
  title: "List findings",
  description:
    "Read. Lists findings of a target, newest activity first: id, title, class, severity, status, invariant, scenario, occurrence count. Filter by status and severity.",
  access: "read",
  input: {
    target_id: z.string().uuid(),
    status: z.union([z.enum(FINDING_STATUSES), z.array(z.enum(FINDING_STATUSES))]).optional(),
    severity: z.union([z.enum(SEVERITIES), z.array(z.enum(SEVERITIES))]).optional(),
    limit: z.number().int().min(1).max(200).optional().describe("Page size, default 50"),
  },
  async handler(context, args) {
    const page = await unwrap(
      context.api.client.GET("/api/v1/findings", {
        params: {
          query: {
            target_id: args.target_id,
            status: asList(args.status),
            severity: asList(args.severity),
            limit: args.limit ?? 50,
          },
        },
      }),
    );
    return {
      findings: page.items.map((finding) => ({
        id: finding.id,
        title: finding.title,
        class: finding.class,
        severity: finding.severity,
        status: finding.status,
        invariant_id: finding.invariant_id,
        scenario_id: finding.scenario_id,
        occurrence_count: finding.occurrence_count,
        first_seen_at: finding.first_seen_at,
        last_seen_at: finding.last_seen_at,
        known_gap_reason: finding.known_gap_reason,
        ticket_url: finding.ticket_url,
      })),
      has_more: page.next_cursor !== null,
    };
  },
});

function clip(text: string | null | undefined) {
  if (text === null || text === undefined) {
    return { value: null, cut: false };
  }
  const result = cutValue(text, TRANSCRIPT_TEXT_BYTES);
  return { value: result.value, cut: result.truncated };
}

function summariseRepro(repro: Schemas["FindingRepro"]) {
  const transcript = cutList(repro.transcript, TRANSCRIPT_LIMIT);
  const yaml = cutValue(repro.scenario_yaml, SCENARIO_YAML_CUT_BYTES);
  const oracleRows = cutList(repro.oracle_rows, ORACLE_ROW_LIMIT);
  const screencast = cutList(repro.screencast, SCREENCAST_LIMIT);
  return {
    run_id: repro.run_id,
    run_scenario_id: repro.run_scenario_id,
    scenario_id: repro.scenario_id,
    scenario_version: repro.scenario_version,
    bundle_version: repro.bundle_version,
    attempt: repro.attempt,
    invariant_id: repro.invariant_id,
    clock: repro.clock,
    seed: repro.seed,
    browser_session_id: repro.browser_session_id,
    scenario_yaml: yaml.value,
    scenario_yaml_truncated: yaml.truncated,
    oracle_rows: oracleRows.items,
    oracle_rows_total: oracleRows.total,
    transcript: transcript.items.map((row) => {
      const ask = clip(row.ask);
      const answer = clip(row.answer);
      return {
        index: row.index,
        step_id: row.step_id,
        label: row.label,
        ask: ask.value,
        answer: answer.value,
        text_cut: ask.cut || answer.cut,
      };
    }),
    transcript_total: transcript.total,
    transcript_truncated: transcript.truncated,
    screencast: screencast.items.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      mime: artifact.mime,
      size_bytes: artifact.size_bytes,
      expires_at: artifact.expires_at,
      url: artifact.url,
    })),
  };
}

export const getFinding = defineTool({
  name: "get_finding",
  title: "Get finding",
  description:
    "Read. One finding with expected and actual, the latest explanation (with structured fields when present) and the repro: scenario YAML, seed, clock, oracle rows and the transcript cut at 40 rows. Use get_step with a transcript step_id for full payloads.",
  access: "read",
  input: {
    finding_id: z.string().uuid(),
  },
  async handler(context, args) {
    const path = { finding_id: args.finding_id };
    const [finding, repro] = await Promise.all([
      unwrap(context.api.client.GET("/api/v1/findings/{finding_id}", { params: { path } })),
      unwrapOptional(context.api.client.GET("/api/v1/findings/{finding_id}/repro", { params: { path } })),
    ]);
    const expected = cutValue(finding.expected, FINDING_VALUE_CUT_BYTES);
    const actual = cutValue(finding.actual, FINDING_VALUE_CUT_BYTES);
    const explanation = finding.latest_explanation;
    return {
      finding: {
        id: finding.id,
        target_id: finding.target_id,
        title: finding.title,
        class: finding.class,
        severity: finding.severity,
        status: finding.status,
        invariant_id: finding.invariant_id,
        scenario_id: finding.scenario_id,
        promoted_scenario_id: finding.promoted_scenario_id,
        occurrence_count: finding.occurrence_count,
        first_seen_at: finding.first_seen_at,
        first_seen_run_id: finding.first_seen_run_id,
        last_seen_at: finding.last_seen_at,
        last_seen_run_id: finding.last_seen_run_id,
        known_gap_reason: finding.known_gap_reason,
        ticket_url: finding.ticket_url,
        expected: expected.value,
        actual: actual.value,
        values_truncated: expected.truncated || actual.truncated,
      },
      latest_explanation: explanation
        ? {
            id: explanation.id,
            created_at: explanation.created_at,
            source: explanation.source,
            text: cutValue(explanation.text, SCENARIO_YAML_CUT_BYTES).value,
            structured: explanation.structured ?? null,
          }
        : null,
      repro: repro ? summariseRepro(repro) : null,
    };
  },
});

export const addExplanation = defineTool({
  name: "add_explanation",
  title: "Add explanation",
  description:
    "Write. Posts an explanation to a finding: free text of at most 20,000 characters, the server's default limit (a server configured with a different TESSA_EXPLANATION_MAX_CHARS answers 422 string_too_long above its own limit), plus an optional structured object (opinion app_bug, scenario_bug, harness or unknown; root_cause up to 2,000 characters; files with paths relative to the repository root, at most 300 characters, and line ranges like 12-40; commit: the commit that introduced the defect, 7 to 40 lowercase hex digits, left out when it is not known; fix_branch without spaces; confidence). Never include secrets or values from .env.",
  access: "write",
  idempotent: false,
  input: {
    finding_id: z.string().uuid(),
    text: z
      .string()
      .min(1)
      .max(EXPLANATION_TEXT_MAX_CHARS, `text is at most ${EXPLANATION_TEXT_MAX_CHARS} characters`)
      .refine(isNotBlank, "text must not be blank"),
    structured: structuredInput.optional(),
  },
  async handler(context, args) {
    const explanation = await unwrap(
      context.api.client.POST("/api/v1/findings/{finding_id}/explanations", {
        params: { path: { finding_id: args.finding_id } },
        body: { text: args.text, structured: structuredBody(args.structured) },
      }),
    );
    return {
      explanation: {
        id: explanation.id,
        finding_id: explanation.finding_id,
        created_at: explanation.created_at,
        source: explanation.source,
        has_structured: args.structured !== undefined,
      },
    };
  },
});

export const moveFinding = defineTool({
  name: "move_finding",
  title: "Move finding",
  description:
    "Write. Moves a finding to a new status (new, triaged, in_fix, verifying, known_gap, dismissed; resolved is only ever set by Tessa after a passing re-run). known_gap needs known_gap_reason. The API enforces the allowed transitions.",
  access: "write",
  idempotent: true,
  input: {
    finding_id: z.string().uuid(),
    status: z.enum(MOVABLE_STATUSES),
    known_gap_reason: z.string().min(3).max(500).optional(),
  },
  async handler(context, args) {
    const finding = await unwrap(
      context.api.client.PATCH("/api/v1/findings/{finding_id}", {
        params: { path: { finding_id: args.finding_id } },
        body: { status: args.status, known_gap_reason: args.known_gap_reason },
      }),
    );
    return {
      finding: {
        id: finding.id,
        title: finding.title,
        status: finding.status,
        severity: finding.severity,
        known_gap_reason: finding.known_gap_reason,
        ticket_url: finding.ticket_url,
      },
    };
  },
});
