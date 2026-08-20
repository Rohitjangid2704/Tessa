import { QueryClient, hashKey, partialMatchKey, type QueryKey } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { qk } from "./query-keys";

const RUN_A = "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11";
const RUN_B = "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e22";
const TARGET = "0198f6f2-8a11-7c33-8e02-19d0a5a7c9b4";
const FILTERS = { target_id: TARGET, status: ["running"] };

function isPrefix(prefix: QueryKey, key: QueryKey): boolean {
  return partialMatchKey(key, prefix);
}

const PHASE_2_TO_4_KEYS: Record<string, readonly unknown[]> = {
  "plans.all": qk.plans.all(),
  "plans.lists": qk.plans.lists(),
  "plans.list": qk.plans.list(FILTERS),
  "plans.detail": qk.plans.detail("p1"),
  "plans.previews": qk.plans.previews(),
  "plans.preview": qk.plans.preview({ k: 1 }),
  "runs.lists": qk.runs.lists(),
  "runs.list": qk.runs.list(FILTERS),
  "runs.forRun": qk.runs.forRun(RUN_A),
  "runs.detail": qk.runs.detail(RUN_A),
  "runs.events": qk.runs.events(RUN_A),
  "runs.eventsTail": qk.runs.eventsTail(RUN_A),
  "runs.scenarios": qk.runs.scenarios(RUN_A),
  "runs.scenarios.filtered": qk.runs.scenarios(RUN_A, { status: ["finished"] }),
  "runs.browserSessions": qk.runs.browserSessions(RUN_A),
  "runScenarios.all": qk.runScenarios.all(),
  "runScenarios.detail": qk.runScenarios.detail("rs1"),
  "steps.all": qk.steps.all(),
  "steps.detail": qk.steps.detail("s1"),
  "scenarios.all": qk.scenarios.all(),
  "scenarios.lists": qk.scenarios.lists(),
  "scenarios.list": qk.scenarios.list(FILTERS),
  "scenarios.detail": qk.scenarios.detail("sc1"),
  "seeds.all": qk.seeds.all(),
  "seeds.lists": qk.seeds.lists(),
  "seeds.list": qk.seeds.list(TARGET),
  "seeds.detail": qk.seeds.detail("sd1"),
  "oracle.all": qk.oracle.all(),
  "oracle.templateLists": qk.oracle.templateLists(),
  "oracle.templates": qk.oracle.templates(FILTERS),
  "oracle.template": qk.oracle.template("t1"),
  "oracle.result": qk.oracle.result("r1"),
  "oracle.results": qk.oracle.results("t1"),
  probes: qk.probes(),
  "probes.filtered": qk.probes({ pack: ["generic"] }),
  "labels.all": qk.labels.all(),
  "labels.queues": qk.labels.queues(),
  "labels.queue": qk.labels.queue(FILTERS),
  "labels.lists": qk.labels.lists(),
  "labels.list": qk.labels.list(FILTERS),
  "labels.own": qk.labels.own("step", "s1"),
  "labels.stats": qk.labels.stats(),
  settings: qk.settings(),
};

describe("phase 2 to 4 query keys", () => {
  it("builds the same key for the same arguments", () => {
    expect(qk.runs.detail(RUN_A)).toEqual(qk.runs.detail(RUN_A));
    expect(hashKey(qk.runs.list({ ...FILTERS }))).toBe(hashKey(qk.runs.list({ ...FILTERS })));
    expect(qk.labels.own("step", "s1")).toEqual(qk.labels.own("step", "s1"));
    expect(qk.probes()).toEqual(qk.probes());
  });

  it("ignores the order of filter keys", () => {
    expect(hashKey(qk.runs.list({ a: 1, b: 2 }))).toBe(hashKey(qk.runs.list({ b: 2, a: 1 })));
    expect(hashKey(qk.plans.preview({ k: 1, depth: "smoke" }))).toBe(
      hashKey(qk.plans.preview({ depth: "smoke", k: 1 })),
    );
  });

  it("gives every factory a distinct key", () => {
    const hashes = Object.values(PHASE_2_TO_4_KEYS).map((key) => hashKey(key));
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("separates keys by argument", () => {
    expect(hashKey(qk.runs.detail(RUN_A))).not.toBe(hashKey(qk.runs.detail(RUN_B)));
    expect(hashKey(qk.runs.list({ status: ["running"] }))).not.toBe(
      hashKey(qk.runs.list({ status: ["failed"] })),
    );
    expect(hashKey(qk.labels.own("step", "x"))).not.toBe(
      hashKey(qk.labels.own("judge_result", "x")),
    );
    expect(hashKey(qk.seeds.list("t1"))).not.toBe(hashKey(qk.seeds.list("t2")));
    expect(hashKey(qk.oracle.result("x"))).not.toBe(hashKey(qk.oracle.results("x")));
  });

  it("starts every key of a family with the family prefix", () => {
    const families: Record<string, { prefix: QueryKey; keys: string[] }> = {
      plans: {
        prefix: qk.plans.all(),
        keys: ["plans.lists", "plans.list", "plans.detail", "plans.previews", "plans.preview"],
      },
      runs: {
        prefix: qk.runs.all(),
        keys: [
          "runs.lists",
          "runs.list",
          "runs.forRun",
          "runs.detail",
          "runs.events",
          "runs.eventsTail",
          "runs.scenarios",
          "runs.scenarios.filtered",
          "runs.browserSessions",
        ],
      },
      runScenarios: {
        prefix: qk.runScenarios.all(),
        keys: ["runScenarios.detail"],
      },
      steps: { prefix: qk.steps.all(), keys: ["steps.detail"] },
      scenarios: {
        prefix: qk.scenarios.all(),
        keys: ["scenarios.lists", "scenarios.list", "scenarios.detail"],
      },
      seeds: {
        prefix: qk.seeds.all(),
        keys: ["seeds.lists", "seeds.list", "seeds.detail"],
      },
      oracle: {
        prefix: qk.oracle.all(),
        keys: [
          "oracle.templateLists",
          "oracle.templates",
          "oracle.template",
          "oracle.result",
          "oracle.results",
        ],
      },
      probes: { prefix: qk.probes(), keys: ["probes.filtered"] },
      labels: {
        prefix: qk.labels.all(),
        keys: [
          "labels.queues",
          "labels.queue",
          "labels.lists",
          "labels.list",
          "labels.own",
          "labels.stats",
        ],
      },
    };
    for (const { prefix, keys } of Object.values(families)) {
      for (const name of keys) {
        expect(isPrefix(prefix, PHASE_2_TO_4_KEYS[name] ?? [])).toBe(true);
      }
    }
  });

  it("keeps the families out of each other's prefix", () => {
    expect(isPrefix(qk.plans.all(), qk.runs.list({}))).toBe(false);
    expect(isPrefix(qk.runs.all(), qk.runScenarios.detail("x"))).toBe(false);
    expect(isPrefix(qk.runScenarios.all(), qk.runs.detail(RUN_A))).toBe(false);
    expect(isPrefix(qk.scenarios.all(), qk.runScenarios.all())).toBe(false);
    expect(isPrefix(qk.seeds.all(), qk.oracle.all())).toBe(false);
    expect(isPrefix(qk.probes(), qk.settings())).toBe(false);
  });

  it("scopes a run's keys under forRun and nothing else", () => {
    const scope = qk.runs.forRun(RUN_A);
    expect(isPrefix(scope, qk.runs.detail(RUN_A))).toBe(true);
    expect(isPrefix(scope, qk.runs.events(RUN_A))).toBe(true);
    expect(isPrefix(scope, qk.runs.scenarios(RUN_A, FILTERS))).toBe(true);
    expect(isPrefix(scope, qk.runs.browserSessions(RUN_A))).toBe(true);
    expect(isPrefix(scope, qk.runs.detail(RUN_B))).toBe(false);
    expect(isPrefix(scope, qk.runs.list(FILTERS))).toBe(false);
  });

  it("lets the run scenarios prefix reach every filtered variant", () => {
    expect(isPrefix(qk.runs.scenarios(RUN_A), qk.runs.scenarios(RUN_A, FILTERS))).toBe(true);
    expect(isPrefix(qk.runs.scenarios(RUN_A), qk.runs.scenarios(RUN_B, FILTERS))).toBe(false);
    expect(isPrefix(qk.runs.scenarios(RUN_A, FILTERS), qk.runs.scenarios(RUN_A))).toBe(false);
  });

  it("separates list prefixes from detail keys", () => {
    expect(isPrefix(qk.runs.lists(), qk.runs.list(FILTERS))).toBe(true);
    expect(isPrefix(qk.runs.lists(), qk.runs.detail(RUN_A))).toBe(false);
    expect(isPrefix(qk.plans.previews(), qk.plans.preview({ k: 2 }))).toBe(true);
    expect(isPrefix(qk.plans.previews(), qk.plans.detail("p1"))).toBe(false);
    expect(isPrefix(qk.oracle.templateLists(), qk.oracle.templates(FILTERS))).toBe(true);
    expect(isPrefix(qk.oracle.templateLists(), qk.oracle.template("t1"))).toBe(false);
    expect(isPrefix(qk.labels.queues(), qk.labels.queue(FILTERS))).toBe(true);
    expect(isPrefix(qk.labels.queues(), qk.labels.list(FILTERS))).toBe(false);
    expect(isPrefix(qk.seeds.lists(), qk.seeds.detail("sd1"))).toBe(false);
    expect(isPrefix(qk.scenarios.lists(), qk.scenarios.detail("sc1"))).toBe(false);
  });

  it("keeps the keys that existed before phase 2", () => {
    expect(qk.runs.all()).toEqual(["runs"]);
    expect(qk.runs.events(RUN_A)).toEqual(["runs", RUN_A, "events"]);
    expect(qk.targets.detail("t1")).toEqual(["targets", "detail", "t1"]);
    expect(qk.limits()).toEqual(["limits"]);
  });

  it("invalidates exactly the queries under a prefix", async () => {
    const client = new QueryClient();
    const entries = {
      detailA: qk.runs.detail(RUN_A),
      scenariosA: qk.runs.scenarios(RUN_A, FILTERS),
      sessionsA: qk.runs.browserSessions(RUN_A),
      detailB: qk.runs.detail(RUN_B),
      list: qk.runs.list(FILTERS),
      runScenario: qk.runScenarios.detail("rs1"),
    };
    for (const key of Object.values(entries)) {
      client.setQueryData(key, { ok: true });
    }

    await client.invalidateQueries({ queryKey: qk.runs.forRun(RUN_A) });

    const invalidated = Object.entries(entries)
      .filter(([, key]) => client.getQueryState(key)?.isInvalidated === true)
      .map(([name]) => name);
    expect(invalidated.toSorted()).toEqual(["detailA", "scenariosA", "sessionsA"]);

    await client.invalidateQueries({ queryKey: qk.runs.all() });

    expect(client.getQueryState(entries.detailB)?.isInvalidated).toBe(true);
    expect(client.getQueryState(entries.list)?.isInvalidated).toBe(true);
    expect(client.getQueryState(entries.runScenario)?.isInvalidated).toBe(false);
  });
});
