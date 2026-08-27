export const BASE_URL = "http://tessa.test";
export const TOKEN = "ipt_Zk3pQ9xLm2Vb7Ncw4TyHs8dRf1JgAe6UoXiKq5BnPaM";
export const TOKEN_PREFIX = "ipt_Zk3p";

export const IDS = {
  user: "11111111-1111-4111-8111-111111111111",
  target: "22222222-2222-4222-8222-222222222222",
  productionTarget: "22222222-2222-4222-8222-222222222223",
  bundle: "33333333-3333-4333-8333-333333333333",
  run: "44444444-4444-4444-8444-444444444444",
  runScenario: "55555555-5555-4555-8555-555555555555",
  scenario: "66666666-6666-4666-8666-666666666666",
  step: "77777777-7777-4777-8777-777777777777",
  finding: "88888888-8888-4888-8888-888888888888",
  plan: "99999999-9999-4999-8999-999999999999",
  agentSession: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  explanation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

export const TARGET_TOKEN = "tgt_graphqlfixture22222222";

export function errorBody(code: string, message: string, details: unknown[] = []) {
  return { error: { code, message, request_id: "req-fixture-1", details } };
}

export const user = {
  id: IDS.user,
  email: "engineer@example.test",
  name: "Eng Ineer",
  role: "member",
};

export const targetSummary = {
  id: IDS.target,
  name: "GraphQL Fixture",
  slug: "graphql-fixture",
  tier: "qa",
  app_kind: "api",
  latest_bundle_version: 3,
  completeness_score: 82,
  health: "ok",
  archived_at: null,
  allow_jev: false,
  created_at: "2026-10-01T10:00:00Z",
  team_id: null,
};

export const target = {
  id: IDS.target,
  name: "GraphQL Fixture",
  slug: "graphql-fixture",
  tier: "qa",
  app_kind: "api",
  allow_production: false,
  allow_jev: false,
  archived_at: null,
  created_at: "2026-10-01T10:00:00Z",
  hints: {},
  latest_bundle_id: IDS.bundle,
  target_token: TARGET_TOKEN,
  team_id: null,
};

export const bundleSummary = {
  id: IDS.bundle,
  version: 3,
  validation_status: "valid",
  completeness_score: 82,
  completeness_status: "meets_bar",
  feature_count: 6,
  hash: "abc123",
  source: "zip",
  uploaded_at: "2026-10-02T10:00:00Z",
};

export const environment = {
  missing_required: 1,
  items: [
    {
      name: "GRAPHQL_URL",
      kind: "url",
      required: true,
      secret: false,
      has_value: true,
      stale: false,
      purpose: "Base URL of the GraphQL server",
      interface_ids: ["graphql_api"],
      last_set_at: "2026-10-02T10:00:00Z",
      last_set_by: IDS.user,
      value: "http://localhost:8521",
      health: { status: "ok", checked_at: "2026-10-02T10:01:00Z", latency_ms: 12, message: null },
    },
    {
      name: "STAFF_TOKEN",
      kind: "token",
      required: true,
      secret: true,
      has_value: false,
      stale: false,
      purpose: "Token of the staff role",
      interface_ids: ["graphql_api"],
      last_set_at: null,
      last_set_by: null,
      value: null,
      health: { status: "unchecked", checked_at: null, latency_ms: null, message: null },
    },
  ],
};

export const ITEM_KEYS = ["billing.refund.partial", "auth.login.lockout", "rooms.search.filters"];

export function uuidFor(prefix: string, index: number): string {
  return `${prefix}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

export function proposalItem(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: uuidFor("1000000a", index),
    key: ITEM_KEYS[index] ?? `item.number-${index}`,
    title: `Item ${index}`,
    area: index % 2 === 0 ? "Billing" : "Auth",
    feature_ids: [`feature.${index}`],
    interface_id: null,
    kind: "api",
    risk: index === 0 ? "high" : "medium",
    reasons: [{ code: "money_path", note: "refunds.py moves money" }],
    needs: ["seed"],
    depth: "standard",
    estimate: { scenarios: 4, minutes: 6 },
    confidence: "medium",
    evidence: "app/billing/refunds.py",
    status: index === 1 ? "selected" : "proposed",
    note: null,
    selected_by: null,
    selected_at: null,
    cell_ids: [uuidFor("2000000a", index), uuidFor("2000000b", index)],
    scenario_ids: [],
    ...overrides,
  };
}

export const proposal = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  target_id: IDS.target,
  bundle_id: IDS.bundle,
  commit_sha: "abc1234",
  branch: "main",
  generated_at: "2026-10-03T10:00:00Z",
  source: "bundle",
  created_by: IDS.user,
  created_at: "2026-10-03T10:00:00Z",
  stale: false,
  items: [proposalItem(0), proposalItem(1), proposalItem(2)],
};

export function proposalWithItems(count: number, overrides: Record<string, unknown> = {}) {
  return { ...proposal, items: Array.from({ length: count }, (_, index) => proposalItem(index)), ...overrides };
}

export function proposalDocItem(index: number, overrides: Record<string, unknown> = {}) {
  return {
    key: ITEM_KEYS[index] ?? `item.number-${index}`,
    title: `Item ${index}`,
    area: "Billing",
    feature_ids: [`feature.${index}`],
    kind: "api",
    risk: "high",
    reasons: [{ code: "money_path", note: "refunds.py moves money" }],
    needs: ["seed"],
    depth: "standard",
    estimate: { scenarios: 4, minutes: 6 },
    confidence: "medium",
    evidence: "app/billing/refunds.py",
    ...overrides,
  };
}

export function proposalDoc(itemCount = 2, overrides: Record<string, unknown> = {}) {
  return {
    schema: `${BASE_URL}/schemas/proposal.v1.json`,
    target_token: TARGET_TOKEN,
    generated_at: "2026-10-08T09:30:00Z",
    source: { commit: "3f9c2ab41d7e", branch: "main", dirty: false },
    items: Array.from({ length: itemCount }, (_, index) => proposalDocItem(index)),
    ...overrides,
  };
}

export function coverageCell(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: uuidFor("3000000a", index),
    plan_id: IDS.plan,
    feature_id: `feature.${index}`,
    role: "staff",
    interface_id: "api",
    family: "feature",
    status: index % 3 === 0 ? "needs_author" : "covered",
    scenario_count: index % 3 === 0 ? 0 : 2,
    last_verdict: null,
    reason: index % 3 === 0 ? "no scenario for this role" : null,
    skip_reason: null,
    proposal_item_ids: [],
    ...overrides,
  };
}

export function coverageMap(cellCount: number) {
  const cells = Array.from({ length: cellCount }, (_, index) => coverageCell(index));
  const totals = { empty: 0, generated: 0, covered: 0, needs_author: 0, blocked: 0 };
  for (const cell of cells) {
    totals[cell.status as keyof typeof totals] += 1;
  }
  return {
    target_id: IDS.target,
    plan_id: IDS.plan,
    bundle_id: IDS.bundle,
    rows: [{ area: "Billing", feature_id: "feature.0", title: "Feature 0" }],
    columns: [{ role: "staff", interface_id: "api" }],
    cells,
    totals,
  };
}

export function scenarioSummary(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: uuidFor("4000000a", index),
    target_id: IDS.target,
    bundle_id: IDS.bundle,
    cell_id: uuidFor("3000000a", index),
    feature_id: `feature.${index}`,
    family: "feature",
    title: `Scenario ${index}`,
    origin: "authored",
    status: "in_review",
    synthetic: false,
    provenance: null,
    validation: { valid: true, errors: [], warnings: [] },
    version: 1,
    created_at: "2026-10-08T10:00:00Z",
    updated_at: "2026-10-08T10:05:00Z",
    ...overrides,
  };
}

export const planFixture = {
  id: IDS.plan,
  target_id: IDS.target,
  bundle_id: IDS.bundle,
  name: "From proposal",
  saved: true,
  selection: { interface_mode: "both", depth: "standard", k: 1, feature_ids: ["feature.1"], roles: ["all"], area_ids: [] },
  effective_budget: { max_usd: 5, max_minutes: 30 },
  include_api_fuzz: false,
  is_coverage_baseline: false,
  cells_total: 2,
  schedule_id: null,
  created_by: IDS.user,
  created_at: "2026-10-08T10:00:00Z",
};

export const agentSession = {
  id: IDS.agentSession,
  user_id: IDS.user,
  user_name: "Eng Ineer",
  target_id: null,
  claude_session_id: "claude-session-1",
  cwd_label: "repo",
  plugin_version: "0.1.0",
  started_at: "2026-10-08T10:00:00Z",
  ended_at: null,
  summary: null,
  write_count: 0,
  active: true,
};

export const completeness = {
  score: 82,
  bar: 70,
  status: "meets_bar",
  checks: [{ id: "scenarios", label: "Scenarios", passed: true, weight: 10, earned: 10 }],
};

export const validationReport = {
  validation_status: "invalid",
  errors: [
    {
      code: "missing_field",
      message: "interfaces[0].base_path is required",
      severity: "error",
      file: "manifest.yaml",
      pointer: "/interfaces/0/base_path",
      line: 12,
      column: null,
    },
  ],
  warnings: [],
  completeness,
  diff_summary: {
    features_added: 1,
    features_removed: 0,
    features_changed: 2,
    against_bundle_id: null,
    against_version: null,
  },
  fixup_items: [
    {
      kind: "error",
      location: "manifest.yaml /interfaces/0/base_path line 12",
      message: "interfaces[0].base_path is required",
      fix_hint: "Add base_path",
    },
  ],
  hooks_missing: [],
  feature_count: 6,
  file_count: 9,
  size_bytes: 4096,
  proposal: null,
  commit_sha: null,
  branch: null,
};

export const bundle = {
  id: IDS.bundle,
  target_id: IDS.target,
  version: 4,
  validation_status: "valid",
  hash: "def456",
  source: "zip",
  uploaded_at: "2026-10-08T10:00:00Z",
  uploaded_by: IDS.user,
  note: null,
  schema_version: 1,
  feature_count: 6,
  file_count: 9,
  size_bytes: 4096,
  scenarios_imported: 2,
  mutants_imported: 0,
  completeness,
  errors: [],
  warnings: [],
  hooks_missing: [],
  diff_summary: null,
  commit_sha: "abc1234",
  branch: "main",
};

export const bundleDiff = {
  bundle_id: IDS.bundle,
  against_bundle_id: null,
  summary: "1 feature added",
  sections: [{ section: "features", change: "changed" }],
  features: [{ feature_id: "rooms", change: "added", fields_changed: [], before: null, after: {} }],
};

export const verdict = (status: string, reason = "ok") => ({
  status,
  tier: "code",
  confidence: 1,
  reason_code: reason,
  reason,
  skip_reason: null,
});

export function run(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.run,
    kind: "suite",
    status,
    trigger: "api",
    target_id: IDS.target,
    plan_id: IDS.plan,
    bundle_id: IDS.bundle,
    read_only: false,
    run_group_id: null,
    created_by: IDS.user,
    created_at: "2026-10-08T10:00:00Z",
    started_at: "2026-10-08T10:00:01Z",
    finished_at: status === "completed" ? "2026-10-08T10:02:00Z" : null,
    stop_requested_at: null,
    workflow_id: "wf-1",
    event_head_seq: 10,
    temporal_ui_url: null,
    budget: { max_usd: 5, spent_usd: 0.2, max_minutes: 30, elapsed_ms: 1000 },
    counters: {
      scenarios_total: 3,
      scenarios_done: 2,
      pass: 1,
      fail: 1,
      flaky: 0,
      uncertain: 0,
      skipped: 0,
      steps_recorded: 8,
    },
    config_snapshot: runConfigSnapshot(),
    ...overrides,
  };
}

export function runConfigSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    bundle_id: IDS.bundle,
    bundle_version: 3,
    bundle_hash: "abc123",
    seed_hash: null,
    clock: null,
    models: null,
    probe_bank_version: null,
    prompt_template_versions: {},
    scenario_versions: {},
    scenario_ids: null,
    ...overrides,
  };
}

export const runStats = {
  k: 1,
  pass_hat_k: 0.5,
  flaky_rate: 0,
  open_findings: 1,
  cost_usd: { total: 0.2, p50: 0.05, p90: 0.1 },
  latency_ms: { p50: 100, p90: 300, p99: 500 },
  tiers: { code: 3, laya: 0, judge: 0, human: 0 },
  families: [
    { family: "functional", scenarios: 3, pass_hat_k: 0.5, flaky: 0, uncertain: 0, skipped: 0 },
  ],
  invariants: [
    { invariant_id: "no_5xx", pack: "generic", pass: 3, fail: 0, flaky: 0, uncertain: 0, skipped: 0 },
    {
      invariant_id: "idempotent_writes",
      pack: "generic",
      pass: 1,
      fail: 1,
      flaky: 0,
      uncertain: 0,
      skipped: 0,
    },
  ],
};

export const runScenarioSummaries = [
  {
    id: IDS.runScenario,
    scenario_id: IDS.scenario,
    title: "Create issue as staff",
    family: "functional",
    role: "staff",
    interface_id: "graphql_api",
    status: "finished",
    verdict: verdict("fail", "tier0_failure"),
    attempts_total: 1,
    attempts_done: 1,
    duration_ms: 420,
  },
  {
    id: "55555555-5555-4555-8555-555555555556",
    scenario_id: "66666666-6666-4666-8666-666666666667",
    title: "List rooms",
    family: "functional",
    role: "staff",
    interface_id: "graphql_api",
    status: "finished",
    verdict: verdict("pass"),
    attempts_total: 1,
    attempts_done: 1,
    duration_ms: 120,
  },
];

export const runScenarioDetail = {
  ...runScenarioSummaries[0],
  steps: [
    {
      id: IDS.step,
      index: 0,
      attempt: 0,
      label: "createIssue",
      adapter: "graphql",
      ok: true,
      latency_ms: 90,
      cost_usd: 0,
      screenshot_count: 0,
      tier0_failure_count: 1,
      verdict: verdict("fail", "tier0_failure"),
    },
    {
      id: "77777777-7777-4777-8777-777777777778",
      index: 1,
      attempt: 0,
      label: "listIssues",
      adapter: "graphql",
      ok: true,
      latency_ms: 30,
      cost_usd: 0,
      screenshot_count: 0,
      tier0_failure_count: 0,
      verdict: verdict("pass"),
    },
  ],
  attempts: [],
  scenario_yaml: "id: x",
  skip_reason: null,
};

export function step(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.step,
    run_id: IDS.run,
    run_scenario_id: IDS.runScenario,
    index: 0,
    attempt: 0,
    label: "createIssue",
    adapter: "graphql",
    started_at: "2026-10-08T10:00:01Z",
    finished_at: "2026-10-08T10:00:02Z",
    latency_ms: 90,
    cost_usd: 0,
    verdict: verdict("fail", "tier0_failure"),
    tier0: { passed: false, failures: [{ check: "status", message: "expected 200", expected: 200, actual: 500 }] },
    judge: null,
    probes: [],
    gold_points: [],
    db_checks: [],
    tools: [],
    cards: [],
    ask: null,
    answer: null,
    request: { kind: "graphql", query: "mutation { createIssue }" },
    response: { kind: "graphql", status: 500, body: { errors: [{ message: "boom" }] } },
    evidence: null,
    payload_purged: false,
    response_truncated: false,
    artifacts: [
      {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        kind: "screenshot",
        mime: "image/png",
        size_bytes: 2048,
        expires_at: "2026-10-08T11:00:00Z",
        url: "/api/v1/artifacts/signed-token-1",
      },
    ],
    ...overrides,
  };
}

export const runDiff = {
  new_failures: [IDS.scenario],
  fixed: [],
  still_failing: [],
  flaky_changes: [],
  cost_delta_usd: 0.01,
  latency_p50_delta_ms: 5,
  items: [
    {
      category: "new_failure",
      title: "Create issue as staff",
      family: "functional",
      role: "staff",
      interface_id: "graphql_api",
      scenario_id: IDS.scenario,
      run_scenario_id: IDS.runScenario,
      against_run_scenario_id: null,
      comparable: true,
      before: verdict("pass"),
      after: verdict("fail"),
    },
  ],
};

export const findingSummary = {
  id: IDS.finding,
  target_id: IDS.target,
  title: "Create issue returns 500",
  class: "server_error",
  severity: "high",
  status: "new",
  fingerprint: "fp-1",
  invariant_id: null,
  scenario_id: IDS.scenario,
  promoted_scenario_id: null,
  occurrence_count: 2,
  first_seen_at: "2026-10-08T10:00:00Z",
  last_seen_at: "2026-10-08T10:05:00Z",
  known_gap_reason: null,
  ticket_url: null,
};

export const finding = {
  ...findingSummary,
  expected: { status: 200 },
  actual: { status: 500 },
  first_seen_run_id: IDS.run,
  last_seen_run_id: IDS.run,
  latest_explanation: {
    id: IDS.explanation,
    finding_id: IDS.finding,
    created_at: "2026-10-08T10:10:00Z",
    created_by: IDS.user,
    source: "claude_code",
    text: "The resolver throws when the room id is missing.",
    structured: {
      opinion: "app_bug",
      root_cause: "Missing null check",
      files: [{ path: "src/resolvers/issue.ts", lines: "12-40" }],
      commit: "abc1234",
      fix_branch: null,
      confidence: "high",
    },
  },
};

export function repro(transcriptRows: number) {
  return {
    finding_id: IDS.finding,
    run_id: IDS.run,
    run_scenario_id: IDS.runScenario,
    scenario_id: IDS.scenario,
    scenario_version: 2,
    bundle_version: 3,
    attempt: 0,
    invariant_id: null,
    browser_session_id: null,
    clock: { mode: "real", at: "2026-10-08T10:00:00Z" },
    seed: { version: 1, hash: "seedhash" },
    expected: { status: 200 },
    actual: { status: 500 },
    scenario_yaml: "id: create_issue\nsteps: []\n",
    oracle_rows: [],
    screencast: [],
    transcript: Array.from({ length: transcriptRows }, (_, index) => ({
      index,
      step_id: `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`,
      label: `step ${index}`,
      ask: `ask ${index} ${"q".repeat(2000)}`,
      answer: `answer ${index}`,
    })),
  };
}

export const explanationCreated = {
  id: IDS.explanation,
  finding_id: IDS.finding,
  created_at: "2026-10-08T10:10:00Z",
  created_by: IDS.user,
  source: "claude_code",
  text: "x",
};

export const promptIssue = {
  id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  target_id: IDS.target,
  target_token: TARGET_TOKEN,
  template_name: "discovery",
  template_version: 2,
  issued_at: "2026-10-08T10:00:00Z",
  issued_by: IDS.user,
  params: {},
  text: "Discover this app and write the tessa folder.",
};

export const healthReport = {
  target_id: IDS.target,
  checked_at: "2026-10-08T10:20:00Z",
  interfaces: [
    {
      interface_id: "graphql_api",
      kind: "graphql",
      status: "ok",
      latency_ms: 15,
      message: null,
      variables: ["GRAPHQL_URL"],
    },
    {
      interface_id: "truth:db",
      kind: "truth_source",
      status: "failed",
      latency_ms: null,
      message: "connection refused",
      variables: ["DB_URL"],
    },
  ],
};
