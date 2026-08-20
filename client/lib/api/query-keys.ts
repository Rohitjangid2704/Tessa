import type { FindingStatus, InvariantPack, LabelSubjectType, TrendMetric } from "./types";

const CATALOG_ROOT = ["catalog"] as const;

export const qk = {
  me: () => ["me"] as const,
  system: {
    all: () => ["system"] as const,
    health: () => ["system", "health"] as const,
    dependencies: () => ["system", "dependencies"] as const,
    schemas: () => ["system", "schemas"] as const,
    schema: (name: string, version: number) => ["system", "schemas", name, version] as const,
  },
  plans: {
    all: () => ["plans"] as const,
    lists: () => ["plans", "list"] as const,
    list: (filters: object) => ["plans", "list", filters] as const,
    detail: (planId: string) => ["plans", "detail", planId] as const,
    previews: () => ["plans", "preview"] as const,
    preview: (selection: object) => ["plans", "preview", selection] as const,
  },
  runs: {
    all: () => ["runs"] as const,
    lists: () => ["runs", "list"] as const,
    list: (filters: object) => ["runs", "list", filters] as const,
    forRun: (runId: string) => ["runs", runId] as const,
    detail: (runId: string) => ["runs", runId, "detail"] as const,
    events: (runId: string) => ["runs", runId, "events"] as const,
    eventsTail: (runId: string) => ["runs", runId, "events", "tail"] as const,
    scenarios: (runId: string, filters?: object) =>
      filters === undefined
        ? (["runs", runId, "scenarios"] as const)
        : (["runs", runId, "scenarios", filters] as const),
    scenarioFacets: (runId: string, scenarioTotal: number) =>
      ["runs", runId, "scenario-facets", scenarioTotal] as const,
    browserSessions: (runId: string) => ["runs", runId, "browser-sessions"] as const,
    stats: (runId: string) => ["runs", runId, "stats"] as const,
    invariants: (runId: string, filters?: object) =>
      filters === undefined
        ? (["runs", runId, "invariants"] as const)
        : (["runs", runId, "invariants", filters] as const),
    diff: (runId: string, against: string | null) => ["runs", runId, "diff", against] as const,
    report: (runId: string) => ["runs", runId, "report"] as const,
    reportHtml: (runId: string) => ["runs", runId, "report-html"] as const,
  },
  runScenarios: {
    all: () => ["run-scenarios"] as const,
    detail: (runScenarioId: string) => ["run-scenarios", "detail", runScenarioId] as const,
  },
  steps: {
    all: () => ["steps"] as const,
    detail: (stepId: string) => ["steps", "detail", stepId] as const,
  },
  scenarios: {
    all: () => ["scenarios"] as const,
    lists: () => ["scenarios", "list"] as const,
    list: (filters: object) => ["scenarios", "list", filters] as const,
    detail: (scenarioId: string) => ["scenarios", "detail", scenarioId] as const,
    versions: (scenarioId: string) => ["scenarios", "versions", scenarioId] as const,
    provenance: (scenarioId: string) => ["scenarios", "provenance", scenarioId] as const,
    validate: (hash: string) => ["scenarios", "validate", hash] as const,
  },
  coverage: {
    all: () => ["coverage"] as const,
    map: (targetId: string, planId: string | null, filters: object) =>
      ["coverage", targetId, planId, filters] as const,
  },
  generation: {
    all: () => ["generation"] as const,
    run: (runId: string) => ["generation", runId] as const,
  },
  personas: {
    all: () => ["personas"] as const,
    list: (targetId: string, filters?: object) =>
      filters === undefined
        ? (["personas", targetId] as const)
        : (["personas", targetId, filters] as const),
    detail: (personaId: string) => ["personas", "detail", personaId] as const,
  },
  goals: {
    all: () => ["goals"] as const,
    list: (targetId: string, filters?: object) =>
      filters === undefined
        ? (["goals", targetId] as const)
        : (["goals", targetId, filters] as const),
    detail: (goalId: string) => ["goals", "detail", goalId] as const,
  },
  simSessions: {
    all: () => ["sim-sessions"] as const,
    list: (runId: string, filters?: object) =>
      filters === undefined
        ? (["sim-sessions", runId] as const)
        : (["sim-sessions", runId, filters] as const),
    detail: (simSessionId: string) => ["sim-sessions", "detail", simSessionId] as const,
  },
  redteam: {
    all: () => ["redteam"] as const,
    families: () => ["redteam", "families"] as const,
    rounds: (runId: string) => ["redteam", "rounds", runId] as const,
  },
  attacks: {
    all: () => ["attacks"] as const,
    list: (runId: string, filters?: object) =>
      filters === undefined
        ? (["attacks", runId] as const)
        : (["attacks", runId, filters] as const),
  },
  mutants: {
    all: () => ["mutants"] as const,
    list: (targetId: string, filters?: object) =>
      filters === undefined
        ? (["mutants", targetId] as const)
        : (["mutants", targetId, filters] as const),
  },
  mutation: {
    all: () => ["mutation"] as const,
    summary: (targetId: string) => ["mutation", "summary", targetId] as const,
    runs: (targetId: string, mutantId: string | null) =>
      ["mutation", "runs", targetId, mutantId] as const,
    run: (mutationRunId: string) => ["mutation", "run", mutationRunId] as const,
  },
  calibration: {
    all: () => ["calibration"] as const,
    report: (targetId: string | null) => ["calibration", "report", targetId] as const,
    fit: (runId: string) => ["calibration", "fit", runId] as const,
  },
  dashboard: {
    all: () => ["dashboard"] as const,
    summary: (targetId: string | null) => ["dashboard", targetId] as const,
  },
  schedules: {
    all: () => ["schedules"] as const,
    lists: () => ["schedules", "list"] as const,
    list: (planId: string | null, filters?: object) =>
      filters === undefined
        ? (["schedules", "list", planId] as const)
        : (["schedules", "list", planId, filters] as const),
    detail: (scheduleId: string) => ["schedules", "detail", scheduleId] as const,
    schema: () => ["schedules", "schema"] as const,
  },
  notifications: {
    all: () => ["notifications"] as const,
    unread: () => ["notifications", "unread"] as const,
    list: (filters: object) => ["notifications", "list", filters] as const,
  },
  contracts: {
    all: () => ["contracts"] as const,
    lists: () => ["contracts", "list"] as const,
    list: (filters: object) => ["contracts", "list", filters] as const,
    detail: (contractCheckId: string) => ["contracts", "detail", contractCheckId] as const,
  },
  library: {
    all: () => ["library"] as const,
    list: (filters: object) => ["library", filters] as const,
  },
  bundleSource: (targetId: string) => ["bundle-source", targetId] as const,
  users: {
    all: () => ["users"] as const,
    lists: () => ["users", "list"] as const,
    list: (filters: object) => ["users", "list", filters] as const,
  },
  teams: {
    all: () => ["teams"] as const,
    list: () => ["teams", "list"] as const,
  },
  retention: () => ["retention"] as const,
  proposals: {
    all: () => ["proposals"] as const,
    current: (targetId: string) => ["proposals", "current", targetId] as const,
  },
  tokens: {
    all: () => ["tokens"] as const,
    mine: () => ["tokens", "mine"] as const,
    forUser: (userId: string) => ["tokens", "user", userId] as const,
  },
  agentSessions: {
    all: () => ["agent-sessions"] as const,
    forTarget: (targetId: string) => ["agent-sessions", { targetId }] as const,
  },
  auditEvents: {
    all: () => ["audit-events"] as const,
    list: (filters: object) => ["audit-events", filters] as const,
  },
  liveProbes: (targetId: string | null, windowHours: number | null) =>
    ["live-probes", targetId, windowHours] as const,
  runGroups: {
    all: () => ["run-groups"] as const,
    detail: (runGroupId: string) => ["run-groups", "detail", runGroupId] as const,
  },
  replays: {
    all: () => ["replays"] as const,
    lists: () => ["replays", "list"] as const,
    list: (filters: object) => ["replays", "list", filters] as const,
    detail: (replayId: string) => ["replays", "detail", replayId] as const,
    records: (replayId: string, filters?: object) =>
      filters === undefined
        ? (["replays", "records", replayId] as const)
        : (["replays", "records", replayId, filters] as const),
  },
  seeds: {
    all: () => ["seeds"] as const,
    lists: () => ["seeds", "list"] as const,
    list: (targetId: string) => ["seeds", "list", targetId] as const,
    detail: (seedId: string) => ["seeds", "detail", seedId] as const,
  },
  oracle: {
    all: () => ["oracle"] as const,
    templateLists: () => ["oracle", "templates"] as const,
    templates: (filters: object) => ["oracle", "templates", filters] as const,
    template: (templateId: string) => ["oracle", "template", templateId] as const,
    result: (resultId: string) => ["oracle", "result", resultId] as const,
    results: (templateId: string) => ["oracle", "results", templateId] as const,
  },
  probes: (filters?: object) =>
    filters === undefined ? (["probes"] as const) : (["probes", filters] as const),
  labels: {
    all: () => ["labels"] as const,
    queues: () => ["labels", "queue"] as const,
    queue: (filters: object) => ["labels", "queue", filters] as const,
    lists: () => ["labels", "list"] as const,
    list: (filters: object) => ["labels", "list", filters] as const,
    own: (subjectType: LabelSubjectType, subjectId: string) =>
      ["labels", "own", subjectType, subjectId] as const,
    stats: () => ["labels", "stats"] as const,
  },
  findings: {
    all: () => ["findings"] as const,
    lists: () => ["findings", "list"] as const,
    list: (filters: object, status?: FindingStatus) =>
      status === undefined
        ? (["findings", "list", filters] as const)
        : (["findings", "list", filters, status] as const),
    detail: (findingId: string) => ["findings", "detail", findingId] as const,
    occurrences: (findingId: string) => ["findings", "occurrences", findingId] as const,
    repro: (findingId: string) => ["findings", "repro", findingId] as const,
    explanations: (findingId: string) => ["findings", "explanations", findingId] as const,
  },
  invariants: {
    all: () => ["invariants"] as const,
    catalog: (pack?: InvariantPack) => ["invariants", "catalog", pack ?? null] as const,
  },
  trends: {
    all: () => ["trends"] as const,
    series: (targetId: string, metric: TrendMetric, range: string, planId: string | null) =>
      ["trends", targetId, metric, range, planId] as const,
  },
  settings: () => ["settings"] as const,
  targets: {
    all: () => ["targets"] as const,
    options: () => ["targets", "options"] as const,
    lists: () => ["targets", "list"] as const,
    list: (filters: object) => ["targets", "list", filters] as const,
    detail: (targetId: string) => ["targets", "detail", targetId] as const,
    prompts: (targetId: string, templateName?: string) =>
      templateName === undefined
        ? (["targets", "prompts", targetId] as const)
        : (["targets", "prompts", targetId, templateName] as const),
    environment: (targetId: string) => ["targets", "environment", targetId] as const,
    health: (targetId: string) => ["targets", "health", targetId] as const,
    bundles: (targetId: string) => ["targets", "bundles", targetId] as const,
  },
  promptIssues: {
    detail: (promptIssueId: string) => ["prompt-issues", promptIssueId] as const,
    explain: (findingId: string) => ["prompt-issues", "explain", findingId] as const,
    author: (targetId: string, cellIds: readonly string[]) =>
      ["prompt-issues", "author", targetId, cellIds] as const,
    hooks: (bundleId: string) => ["prompt-issues", "hooks", bundleId] as const,
    mutants: (targetId: string, invariantIds: readonly string[]) =>
      ["prompt-issues", "mutants", targetId, invariantIds] as const,
  },
  promptTemplates: {
    all: () => ["prompt-templates"] as const,
    list: () => ["prompt-templates", "list"] as const,
    detail: (name: string, version?: number) =>
      version === undefined
        ? (["prompt-templates", "detail", name] as const)
        : (["prompt-templates", "detail", name, version] as const),
  },
  bundles: {
    all: () => ["bundles"] as const,
    detail: (bundleId: string) => ["bundles", "detail", bundleId] as const,
    diff: (bundleId: string, against: string | null) =>
      ["bundles", "diff", bundleId, against] as const,
    files: (bundleId: string) => ["bundles", "files", bundleId] as const,
    file: (bundleId: string, path: string) => ["bundles", "file", bundleId, path] as const,
  },
  catalogRoot: () => CATALOG_ROOT,
  catalog: (targetId: string, bundleId: string | null, filters: object) =>
    [...CATALOG_ROOT, targetId, bundleId, filters] as const,
  appKinds: () => ["app-kinds"] as const,
  limits: () => ["limits"] as const,
} as const;
