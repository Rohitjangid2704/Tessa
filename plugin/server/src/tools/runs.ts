import { z } from "zod";
import { unwrap, unwrapOptional } from "../client";
import { cutList, cutValue, fitCutBytes } from "../cut";
import { localError } from "../errors";
import type { Schemas } from "../types";
import { defineTool, type ToolContext } from "./define";

export const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled", "budget_exceeded"]);

const FAST_POLL_MILLISECONDS = 1000;
const SLOW_POLL_MILLISECONDS = 5000;
const FAST_POLL_WINDOW_MILLISECONDS = 30_000;
const DEFAULT_WAIT_SECONDS = 300;
const MAX_WAIT_SECONDS = 1800;
const SCENARIO_DETAIL_LIMIT = 10;
const FAILING_STEPS_PER_SCENARIO = 5;
const DIFF_ITEM_LIMIT = 100;
const STEP_PROBE_LIMIT = 30;
const FAILING_VERDICTS = new Set(["fail", "uncertain", "flaky"]);

export function summariseRun(run: Schemas["Run"]) {
  const scenarioIds = run.config_snapshot?.scenario_ids;
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    terminal: TERMINAL_STATUSES.has(run.status),
    trigger: run.trigger,
    target_id: run.target_id,
    plan_id: run.plan_id,
    bundle_id: run.bundle_id,
    read_only: run.read_only,
    subset: Array.isArray(scenarioIds) && scenarioIds.length > 0,
    created_at: run.created_at,
    started_at: run.started_at,
    finished_at: run.finished_at,
    counters: run.counters,
    budget: run.budget,
  };
}

function summariseVerdict(verdict: Schemas["Verdict"] | null | undefined) {
  if (!verdict) {
    return null;
  }
  return {
    status: verdict.status,
    tier: verdict.tier,
    reason_code: verdict.reason_code,
    reason: verdict.reason,
    confidence: verdict.confidence,
    skip_reason: verdict.skip_reason,
  };
}

function artifactUrl(context: ToolContext, url: string): string {
  return url.startsWith("/") ? `${context.api.baseUrl}${url}` : url;
}

export const startRun = defineTool({
  name: "start_run",
  title: "Start run",
  description:
    "Write (spends model and runtime budget; ask the user first). Starts a run from a saved plan_id, from a scenario subset (target_id plus scenario_ids, at most 50 accepted scenarios, invariants and fuzz are skipped), or from an inline plan object. reset_seed true resets the QA data with the bundle's seed reset script before the seed gate checks the seed hash; without it, data written by an earlier run fails the gate with a seed mismatch. A bundle without a seed or a reset script refuses it with 409 target_not_ready (detail seed_missing or hook_missing), another active suite or seed run of the target with 409 conflict (detail active_run), and production always. Returns the run handle; use wait_run next.",
  access: "write",
  idempotent: false,
  input: {
    plan_id: z.string().uuid().optional(),
    target_id: z.string().uuid().optional().describe("Required with scenario_ids"),
    scenario_ids: z.array(z.string().uuid()).min(1).max(50).optional(),
    plan: z.record(z.string(), z.unknown()).optional().describe("Inline plan, same shape as a saved plan"),
    reset_seed: z
      .boolean()
      .optional()
      .describe("Reset the QA data with the seed reset script before the seed gate; default false"),
    max_concurrency: z.number().int().min(1).max(64).optional(),
  },
  async handler(context, args) {
    const modes = [
      args.plan_id !== undefined,
      args.scenario_ids !== undefined,
      args.plan !== undefined,
    ].filter(Boolean).length;
    if (modes !== 1) {
      throw localError(
        "invalid_arguments",
        "Pass exactly one of plan_id, scenario_ids with target_id, or plan",
      );
    }
    if (args.scenario_ids !== undefined && args.target_id === undefined) {
      throw localError("invalid_arguments", "scenario_ids need target_id");
    }
    const handle = await unwrap(
      context.api.client.POST("/api/v1/runs", {
        params: { header: { "Idempotency-Key": context.generateId() } },
        body: {
          plan_id: args.plan_id,
          plan: args.plan as Schemas["PlanCreate"] | undefined,
          scenario_ids: args.scenario_ids,
          target_id: args.scenario_ids ? args.target_id : undefined,
          reset_seed: args.reset_seed ?? false,
          max_concurrency: args.max_concurrency,
        },
      }),
    );
    return {
      run_id: handle.run_id,
      status: handle.status,
      kind: handle.kind,
      workflow_id: handle.workflow_id,
      created_at: handle.created_at,
    };
  },
});

export const waitRun = defineTool({
  name: "wait_run",
  title: "Wait for run",
  description:
    "Read. Polls a run until it is completed, failed, canceled or budget_exceeded, or until timeout_s passes (default 300, at most 1800). Returns the run with counters and timed_out. A timed out call is not a result: call it again or report the last state.",
  access: "read",
  input: {
    run_id: z.string().uuid(),
    timeout_s: z.number().int().min(1).max(MAX_WAIT_SECONDS).optional(),
  },
  async handler(context, args) {
    const timeoutMilliseconds = (args.timeout_s ?? DEFAULT_WAIT_SECONDS) * 1000;
    const startedAt = context.clock.now();
    for (;;) {
      const run = await unwrap(
        context.api.client.GET("/api/v1/runs/{run_id}", { params: { path: { run_id: args.run_id } } }),
      );
      const elapsed = context.clock.now() - startedAt;
      if (TERMINAL_STATUSES.has(run.status)) {
        return { run: summariseRun(run), timed_out: false, waited_ms: elapsed };
      }
      const remaining = timeoutMilliseconds - elapsed;
      if (remaining <= 0) {
        return { run: summariseRun(run), timed_out: true, waited_ms: elapsed };
      }
      const interval = elapsed < FAST_POLL_WINDOW_MILLISECONDS ? FAST_POLL_MILLISECONDS : SLOW_POLL_MILLISECONDS;
      await context.clock.sleep(Math.min(interval, remaining));
    }
  },
});

function summariseStats(stats: Schemas["RunStats"]) {
  const families = cutList(stats.families, 20);
  const attention = stats.invariants.filter(
    (entry) => entry.fail > 0 || entry.flaky > 0 || entry.uncertain > 0,
  );
  return {
    k: stats.k,
    pass_hat_k: stats.pass_hat_k,
    flaky_rate: stats.flaky_rate,
    open_findings: stats.open_findings,
    cost_usd: stats.cost_usd,
    latency_ms: stats.latency_ms,
    tiers: stats.tiers,
    families: families.items,
    families_truncated: families.truncated,
    invariants_needing_attention: cutList(attention, 20).items,
  };
}

async function failingSteps(context: ToolContext, runScenarioId: string) {
  const detail = await unwrap(
    context.api.client.GET("/api/v1/run-scenarios/{run_scenario_id}", {
      params: { path: { run_scenario_id: runScenarioId } },
    }),
  );
  const flagged = detail.steps.filter(
    (step) =>
      (step.verdict && FAILING_VERDICTS.has(step.verdict.status)) ||
      step.tier0_failure_count > 0 ||
      step.ok === false,
  );
  return flagged.slice(0, FAILING_STEPS_PER_SCENARIO).map((step) => ({
    step_id: step.id,
    index: step.index,
    attempt: step.attempt,
    label: step.label,
    adapter: step.adapter,
    tier0_failure_count: step.tier0_failure_count,
    verdict: summariseVerdict(step.verdict),
  }));
}

export const getRun = defineTool({
  name: "get_run",
  title: "Get run",
  description:
    "Read. A run with counters, budget and stats, and its scenarios with verdicts and attempt counts. Scenarios that did not pass list their failing step ids (up to 10 scenarios); read them with get_step. Verdicts are exactly the ones Tessa returned.",
  access: "read",
  input: {
    run_id: z.string().uuid(),
    limit: z.number().int().min(1).max(200).optional().describe("Scenario page size, default 100"),
    only_not_passing: z.boolean().optional().describe("List only scenarios whose verdict is not pass"),
  },
  async handler(context, args) {
    const path = { run_id: args.run_id };
    const [run, stats, scenarios] = await Promise.all([
      unwrap(context.api.client.GET("/api/v1/runs/{run_id}", { params: { path } })),
      unwrapOptional(context.api.client.GET("/api/v1/runs/{run_id}/stats", { params: { path } })),
      unwrap(
        context.api.client.GET("/api/v1/runs/{run_id}/scenarios", {
          params: {
            path,
            query: {
              limit: args.limit ?? 100,
              verdict: args.only_not_passing ? ["fail", "flaky", "uncertain", "skipped"] : undefined,
            },
          },
        }),
      ),
    ]);
    const needsDetail = scenarios.items
      .filter((entry) => entry.verdict && FAILING_VERDICTS.has(entry.verdict.status))
      .slice(0, SCENARIO_DETAIL_LIMIT);
    const details = new Map<string, Awaited<ReturnType<typeof failingSteps>>>();
    await Promise.all(
      needsDetail.map(async (entry) => {
        details.set(entry.id, await failingSteps(context, entry.id));
      }),
    );
    return {
      run: summariseRun(run),
      stats: stats ? summariseStats(stats) : null,
      scenarios: scenarios.items.map((entry) => ({
        run_scenario_id: entry.id,
        scenario_id: entry.scenario_id,
        title: entry.title,
        family: entry.family,
        role: entry.role,
        interface_id: entry.interface_id,
        status: entry.status,
        verdict: summariseVerdict(entry.verdict),
        attempts_done: entry.attempts_done,
        attempts_total: entry.attempts_total,
        duration_ms: entry.duration_ms,
        failing_steps: details.get(entry.id) ?? null,
      })),
      scenarios_total: scenarios.total,
      has_more_scenarios: scenarios.next_cursor !== null,
    };
  },
});

export const getStep = defineTool({
  name: "get_step",
  title: "Get step",
  description:
    "Read. One recorded step: adapter, verdict with tier and reason, Tier-0 failures, judge and probe results, gold points, database checks, and the request, response and evidence each cut at 20 KB (truncated says which were cut). Artifacts come as signed URLs.",
  access: "read",
  input: {
    step_id: z.string().uuid(),
  },
  async handler(context, args) {
    const step = await unwrap(
      context.api.client.GET("/api/v1/steps/{step_id}", { params: { path: { step_id: args.step_id } } }),
    );
    const probes = cutList(step.probes, STEP_PROBE_LIMIT);
    const base = JSON.stringify({
      ...step,
      request: null,
      response: null,
      evidence: null,
      ask: null,
      answer: null,
      probes: probes.items,
    });
    const cutBytes = fitCutBytes(
      [step.request, step.response, step.evidence, step.ask, step.answer],
      Buffer.byteLength(base),
    );
    const request = cutValue(step.request, cutBytes);
    const response = cutValue(step.response, cutBytes);
    const evidence = cutValue(step.evidence, cutBytes);
    const ask = cutValue(step.ask, cutBytes);
    const answer = cutValue(step.answer, cutBytes);
    return {
      id: step.id,
      run_id: step.run_id,
      run_scenario_id: step.run_scenario_id,
      index: step.index,
      attempt: step.attempt,
      label: step.label,
      adapter: step.adapter,
      started_at: step.started_at,
      finished_at: step.finished_at,
      latency_ms: step.latency_ms,
      cost_usd: step.cost_usd,
      verdict: summariseVerdict(step.verdict),
      tier0: step.tier0,
      judge: step.judge,
      probes: probes.items,
      probes_total: probes.total,
      gold_points: step.gold_points,
      db_checks: step.db_checks,
      tools: step.tools,
      ask: ask.value,
      answer: answer.value,
      request: request.value,
      response: response.value,
      evidence: evidence.value,
      payload_purged: step.payload_purged,
      response_truncated_by_harness: step.response_truncated,
      truncated: {
        request: request.truncated,
        response: response.truncated,
        evidence: evidence.truncated,
        ask: ask.truncated,
        answer: answer.truncated,
        probes: probes.truncated,
        cut_bytes: cutBytes,
      },
      artifacts: step.artifacts.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        mime: artifact.mime,
        size_bytes: artifact.size_bytes,
        expires_at: artifact.expires_at,
        url: artifactUrl(context, artifact.url),
      })),
    };
  },
});

export const runDiff = defineTool({
  name: "run_diff",
  title: "Run diff",
  description:
    "Read. Compares a run with another run (default: the previous completed run of the same plan): new failures, fixed, still failing, flaky changes, cost and latency deltas, and the changed scenarios.",
  access: "read",
  input: {
    run_id: z.string().uuid(),
    against: z.string().uuid().optional(),
  },
  async handler(context, args) {
    const diff = await unwrap(
      context.api.client.GET("/api/v1/runs/{run_id}/diff", {
        params: { path: { run_id: args.run_id }, query: { against: args.against } },
      }),
    );
    const items = cutList(diff.items, DIFF_ITEM_LIMIT);
    return {
      new_failures: diff.new_failures,
      fixed: diff.fixed,
      still_failing: diff.still_failing,
      flaky_changes: diff.flaky_changes,
      cost_delta_usd: diff.cost_delta_usd,
      latency_p50_delta_ms: diff.latency_p50_delta_ms,
      items: items.items.map((item) => ({
        category: item.category,
        title: item.title,
        family: item.family,
        role: item.role,
        interface_id: item.interface_id,
        scenario_id: item.scenario_id,
        run_scenario_id: item.run_scenario_id,
        comparable: item.comparable,
        before: summariseVerdict(item.before),
        after: summariseVerdict(item.after),
      })),
      items_total: items.total,
      items_truncated: items.truncated,
    };
  },
});

export const cancelRun = defineTool({
  name: "cancel_run",
  title: "Cancel run",
  description:
    "Write. Asks Tessa to cancel a queued or running run. The run ends as canceled after the current work stops.",
  access: "write",
  destructive: true,
  idempotent: true,
  input: {
    run_id: z.string().uuid(),
  },
  async handler(context, args) {
    const run = await unwrap(
      context.api.client.POST("/api/v1/runs/{run_id}/cancel", {
        params: { path: { run_id: args.run_id } },
      }),
    );
    return { run: summariseRun(run) };
  },
});
