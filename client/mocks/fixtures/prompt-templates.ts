import type { components } from "@/lib/api/schema";

type Schemas = components["schemas"];

export interface PromptTemplateRecord {
  name: Schemas["PromptTemplateName"];
  version: number;
  text: string;
  variables: string[];
  created_at: string;
  is_current: boolean;
}

const DISCOVERY_V1_LINES = [
  "You are preparing this repository for end-to-end testing by Tessa, a QA harness that",
  "tests the RUNNING app from outside (HTTP, streams, webhooks, a real browser) and computes",
  "expected results from the app's own data. Tessa never sees this repo, so everything it",
  "needs must be in the bundle you create. Read the code; do not guess. Mark anything you are",
  "unsure of with `confidence: low`. Never write a real secret: placeholders only.",
  "",
  "Create the folder `tessa/` at the repo root with:",
  "",
  "1. manifest.yaml  (schema {{SCHEMA_URL}}, target_token {{TARGET_TOKEN}})",
  "   app: name, one-paragraph summary, kind (web, api, llm_assistant, worker, cli), how to run,",
  "        health endpoint(s), ports, base paths.",
  "   interfaces: every way a client reaches the app: kind (http, sse, websocket, graphql,",
  "        browser, webhook, cli), base path, auth (type, header, how a token is obtained per",
  "        role), request and response shapes with one real example each, stream event names,",
  "        rate limits, idempotency rules.",
  "   roles: each role, its level, what it may see and do, and the env var that will hold its",
  "        login or token.",
  "   features: the catalog of testable things (section 2.4 shape): id, area, kind, description,",
  "        interfaces, roles, flag, preconditions, at least one concrete example with the",
  "        expected behaviour, which oracle computes the expectation, invariants that apply,",
  "        cleanup needed after a write.",
  "   data_model: stores, tables or collections, key fields, tenant field, status fields,",
  "        soft-delete rules, timezone handling.",
  "   truth_sources: each database or read endpoint an expected result can be computed from,",
  "        with the env var for a READ-ONLY connection.",
  "   seeds: how to make a QA tenant look the same every run (fixtures, reset script, a",
  "        command that prints a hash of the seeded state).",
  "   invariants: rules that must always hold (auth boundaries, tenant isolation, role",
  "        monotonicity, no internal ids, no claim of a save before confirmation, ...) and how",
  "        each can be checked (code, probe, oracle, db).",
  "   flags: feature flags that change behaviour, their env var, what they affect.",
  "   environment: every variable Tessa needs (URLs, tokens, DSNs) with placeholders.",
  "   test_hooks: which QA hooks exist (health, trace by id, usage) and which are missing",
  "        (pin clock, override flags, flush caches).",
  "   limitations, cleanup: what cannot be undone, what to delete after a run, what costs money.",
  "2. README.md: the same content in plain language for a QA engineer, section by section.",
  "3. env.template: every variable in `environment` with a placeholder and a one-line purpose.",
  "4. seeds/: the fixtures and the reset script (SQL or a script) described in `seeds`.",
  "5. oracle/: one read-only reference query per feature with a computable expectation, with",
  "   parameters (tenant, today, role) and the sentence Tessa should expect from the rows.",
  "6. flows/: the key UI paths as ordered steps (url, action, target by accessibility role or",
  "   stable selector, expected state).",
  "7. openapi.json (or a link) when the app exposes a schema.",
  "",
  "Do not modify application code. If the app lacks the QA hooks above, list them under",
  "test_hooks.missing; a separate prompt will ask for them. Finish with a short checklist of",
  "what you could not determine from the code.",
];

const DISCOVERY_HINTS_LINES = ["", "App-specific instructions:", "{{APP_KIND_HINTS}}"];

const DISCOVERY_V2_EXTRA_LINES = [
  "",
  "Format conventions:",
  "- Placeholders are written ${NAME} with NAME matching [A-Z][A-Z0-9_]*; every NAME must be a",
  "  line in env.template.",
  "- oracle/<name>.yaml sits next to its .sql or .py source and holds name, feature_ids,",
  "  language (sql or python), params_schema and sentence_template.",
  "- flows/*.yaml hold id, title, feature_ids, role and ordered steps (url, action, target,",
  "  expect).",
  "- seeds.expected_hash is optional; omit it when the hash command is not reproducible.",
];

const FIXUP_V1_LINES = [
  "You are fixing the Tessa bundle in the folder `tessa/` of this repository. Tessa",
  "validated version {{BUNDLE_VERSION}} of the bundle (schema {{SCHEMA_URL}}, target_token",
  "{{TARGET_TOKEN}}) and scored its completeness {{COMPLETENESS_SCORE}} out of 100; the bar is",
  "{{COMPLETENESS_BAR}}. The open items are listed below.",
  "",
  "Fix exactly what is listed and keep everything that is already correct. Do not modify",
  "application code. Keep the existing ids, `schema` and `target_token` unchanged.",
  "",
  "## Open items",
  "",
  "{{FIXUP_ITEMS}}",
  "",
  "When you finish, list what you changed and what you could not determine from the code.",
];

const FIXUP_V2_LINES = [
  "You are fixing the Tessa bundle in the folder `tessa/` of this repository. Tessa,",
  "a QA harness that tests the RUNNING app from outside (HTTP, streams, webhooks, a real",
  "browser), validated version {{BUNDLE_VERSION}} of the bundle (schema {{SCHEMA_URL}}, target_token",
  "{{TARGET_TOKEN}}) and scored its completeness {{COMPLETENESS_SCORE}} out of 100; the bar is",
  "{{COMPLETENESS_BAR}}. The open items are listed below.",
  "",
  "Fix exactly what is listed and keep everything that is already correct. Read the code; do not",
  "guess. Mark anything you are unsure of with `confidence: low`. Never write a real secret:",
  "placeholders only. Do not modify application code. Keep the existing ids, `schema` and",
  "`target_token` unchanged.",
  "",
  "## Open items",
  "",
  "{{FIXUP_ITEMS}}",
  "",
  "Each item says where Tessa found it (file, JSON pointer into manifest.yaml and line, when",
  "known), what is wrong, and for a completeness check what earns its missing points.",
  "",
  "## When you finish",
  "",
  "Finish with a short list of what you changed and what you still could not determine from the",
  "code. The folder will be zipped and uploaded again; Tessa validates it and compares it",
  "with version {{BUNDLE_VERSION}}.",
];

const EXPLAIN_V1_LINES = [
  "You are investigating a failure that Tessa found while testing the RUNNING app of this",
  "repository from outside. Tessa never sees this repository; you do. Find the root cause in",
  "the code and name the exact files and lines, as path:line. Do not modify any file.",
  "",
  "Finding {{FINDING_ID}} (target token {{TARGET_TOKEN}})",
  "Title: {{FINDING_TITLE}}",
  "Class: {{FINDING_CLASS}}, severity {{FINDING_SEVERITY}}",
  "Violated invariant: {{FINDING_INVARIANT}}",
  "Seen {{OCCURRENCE_COUNT}} times, last in run {{LAST_RUN_ID}}",
  "",
  "## Expected",
  "{{EXPECTED}}",
  "",
  "## Actual",
  "{{ACTUAL}}",
  "",
  "## Transcript of the failing attempt",
  "{{TRANSCRIPT}}",
  "",
  "## What to answer",
  "1. The root cause in one paragraph.",
  "2. The files and lines that cause it, as path:line.",
  "3. The smallest fix you would make, described in words.",
  "4. Anything in this transcript that you could not explain from the code.",
];

const MUTANTS_V1_LINES = [
  "You are building known bugs for Tessa, a QA harness that tests the RUNNING app of this",
  "repository from outside. Tessa measures its own test suite by running it against copies of",
  "the app that each carry exactly one deliberate bug (a mutant). If the suite does not fail on a",
  "mutant, the suite has a blind spot. Target token {{TARGET_TOKEN}}.",
  "",
  "For each invariant below, create one git branch named mutant/<short-slug> that breaks the app so",
  "that this invariant should fail. One bug per branch, as small a code change as possible, and",
  "never a change that crashes the app on start. Do not merge any branch and do not touch main.",
  "",
  "Invariants to cover:",
  "{{INVARIANTS}}",
  "",
  "Then write `tessa/mutants.yaml`, a list with one entry per branch, valid against",
  "{{MUTANT_SCHEMA_URL}}:",
  "- name: the slug of the branch",
  "- branch: the full branch name",
  "- description: what the branch breaks, in one or two sentences",
  "- expected_catchers: the invariant ids that should fail because of it",
  "",
  "Finish with a checklist: which branches still have to be deployed to the QA environment, and",
  "the base URL each one will be served from once deployed.",
];

const HOOKS_V1_LINES = [
  "You are adding QA test hooks to the repository of this app so that Tessa can test it",
  "reliably from outside. Tessa validated version {{BUNDLE_VERSION}} of its bundle (target token",
  "{{TARGET_TOKEN}}) and found that these hooks are missing:",
  "",
  "{{HOOKS}}",
  "",
  "For each hook, add the smallest QA-only route or switch that does what the description says.",
  "A hook must be disabled unless the app runs in the QA environment, must never be reachable in",
  "production, and must be protected by the same authentication as the rest of the QA API.",
  "",
  "Then update `tessa/manifest.yaml`: remove each hook you added from test_hooks.missing and add",
  "it to test_hooks.available with its path and one example request. Finish with a short list of the",
  "hooks you could not add and why.",
];

export const DISCOVERY_V1_TEXT = [...DISCOVERY_V1_LINES, ...DISCOVERY_HINTS_LINES].join("\n");
export const DISCOVERY_V2_TEXT = [
  ...DISCOVERY_V1_LINES,
  ...DISCOVERY_V2_EXTRA_LINES,
  ...DISCOVERY_HINTS_LINES,
].join("\n");
export const FIXUP_V1_TEXT = FIXUP_V1_LINES.join("\n");
export const FIXUP_V2_TEXT = FIXUP_V2_LINES.join("\n");
export const EXPLAIN_V1_TEXT = EXPLAIN_V1_LINES.join("\n");
export const MUTANTS_V1_TEXT = MUTANTS_V1_LINES.join("\n");
export const HOOKS_V1_TEXT = HOOKS_V1_LINES.join("\n");

const DISCOVERY_VARIABLES = ["SCHEMA_URL", "TARGET_TOKEN", "APP_KIND_HINTS"];
const FIXUP_VARIABLES = [
  "BUNDLE_VERSION",
  "SCHEMA_URL",
  "TARGET_TOKEN",
  "COMPLETENESS_SCORE",
  "COMPLETENESS_BAR",
  "FIXUP_ITEMS",
];

const EXPLAIN_VARIABLES = [
  "FINDING_ID",
  "TARGET_TOKEN",
  "FINDING_TITLE",
  "FINDING_CLASS",
  "FINDING_SEVERITY",
  "FINDING_INVARIANT",
  "OCCURRENCE_COUNT",
  "LAST_RUN_ID",
  "EXPECTED",
  "ACTUAL",
  "TRANSCRIPT",
];

const MUTANTS_VARIABLES = ["TARGET_TOKEN", "MUTANT_SCHEMA_URL", "INVARIANTS"];
const HOOKS_VARIABLES = ["TARGET_TOKEN", "BUNDLE_VERSION", "HOOKS"];

export const PROMPT_TEMPLATES: readonly PromptTemplateRecord[] = [
  {
    name: "discovery",
    version: 1,
    text: DISCOVERY_V1_TEXT,
    variables: DISCOVERY_VARIABLES,
    created_at: "2026-09-01T09:00:00.000Z",
    is_current: false,
  },
  {
    name: "discovery",
    version: 2,
    text: DISCOVERY_V2_TEXT,
    variables: DISCOVERY_VARIABLES,
    created_at: "2026-09-20T09:00:00.000Z",
    is_current: true,
  },
  {
    name: "fixup",
    version: 1,
    text: FIXUP_V1_TEXT,
    variables: FIXUP_VARIABLES,
    created_at: "2026-09-01T09:00:00.000Z",
    is_current: false,
  },
  {
    name: "fixup",
    version: 2,
    text: FIXUP_V2_TEXT,
    variables: FIXUP_VARIABLES,
    created_at: "2026-09-20T09:00:00.000Z",
    is_current: true,
  },
  {
    name: "explain",
    version: 1,
    text: EXPLAIN_V1_TEXT,
    variables: EXPLAIN_VARIABLES,
    created_at: "2026-10-01T09:00:00.000Z",
    is_current: true,
  },
  {
    name: "mutants",
    version: 1,
    text: MUTANTS_V1_TEXT,
    variables: MUTANTS_VARIABLES,
    created_at: "2026-10-04T09:00:00.000Z",
    is_current: true,
  },
  {
    name: "hooks",
    version: 1,
    text: HOOKS_V1_TEXT,
    variables: HOOKS_VARIABLES,
    created_at: "2026-10-04T09:00:00.000Z",
    is_current: true,
  },
];

export function toPromptTemplate(record: PromptTemplateRecord): Schemas["PromptTemplate"] {
  return {
    name: record.name,
    version: record.version,
    text: record.text,
    variables: [...record.variables],
    created_at: record.created_at,
  };
}

export function currentTemplate(name: Schemas["PromptTemplateName"]): PromptTemplateRecord | null {
  return PROMPT_TEMPLATES.find((template) => template.name === name && template.is_current) ?? null;
}

export function findTemplate(
  name: Schemas["PromptTemplateName"],
  version: number | null,
): PromptTemplateRecord | null {
  if (version === null) {
    return currentTemplate(name);
  }
  return (
    PROMPT_TEMPLATES.find((template) => template.name === name && template.version === version) ??
    null
  );
}
