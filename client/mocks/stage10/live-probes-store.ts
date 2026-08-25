import type { LiveProbeStat, LiveProbes } from "@/lib/api/types";
import { stableUnit } from "../stage2/ids";
import { mockState } from "../state";

export const LIVE_PROBE_SCENARIOS = ["none", "fresh", "stale", "probe_error"] as const;

export type LiveProbeScenario = (typeof LIVE_PROBE_SCENARIOS)[number];

export const LIVE_PROBES_INGEST_KEY = "dev-only-ingest-key-for-the-mock";

export const LIVE_PROBES_WINDOW_HOURS = 24;

const FRESH_AGE_MS = 3 * 60_000;
const STALE_AGE_MS = 3 * 60 * 60_000;
const RATE_DECIMALS = 1000;

interface ProbeCounter {
  probeId: string;
  n: number;
  passes: number;
  uncertain: number;
  gradable: boolean;
  passChance: number;
  uncertainChance: number;
}

const BASE_COUNTERS: readonly ProbeCounter[] = [
  {
    probeId: "generic.answers_the_question",
    n: 412,
    passes: 376,
    uncertain: 17,
    gradable: true,
    passChance: 0.91,
    uncertainChance: 0.04,
  },
  {
    probeId: "llm_app.refuses_out_of_scope",
    n: 388,
    passes: 322,
    uncertain: 35,
    gradable: true,
    passChance: 0.83,
    uncertainChance: 0.09,
  },
  {
    probeId: "llm_app.leaks_system_prompt",
    n: 401,
    passes: 396,
    uncertain: 2,
    gradable: true,
    passChance: 0.99,
    uncertainChance: 0.005,
  },
  {
    probeId: "target.gracie.names_room",
    n: 96,
    passes: 69,
    uncertain: 17,
    gradable: true,
    passChance: 0.72,
    uncertainChance: 0.18,
  },
];

const UNGRADABLE_COUNTER: ProbeCounter = {
  probeId: "llm_app.cites_source",
  n: 14,
  passes: 0,
  uncertain: 0,
  gradable: false,
  passChance: 0,
  uncertainChance: 0,
};

function emptyCounters(): ProbeCounter[] {
  return BASE_COUNTERS.map((counter) => ({ ...counter, n: 0, passes: 0, uncertain: 0 }));
}

function countersFor(scenario: LiveProbeScenario): ProbeCounter[] {
  const base = BASE_COUNTERS.map((counter) => ({ ...counter }));
  return scenario === "probe_error" ? [...base, { ...UNGRADABLE_COUNTER }] : base;
}

function rate(count: number, total: number): number | null {
  return total === 0 ? null : Math.round((count / total) * RATE_DECIMALS) / RATE_DECIMALS;
}

function statOf(counter: ProbeCounter): LiveProbeStat {
  const rated = counter.gradable && counter.n > 0;
  return {
    probe_id: counter.probeId,
    n: counter.n,
    pass_rate: rated ? rate(counter.passes, counter.n) : null,
    uncertain_rate: rated ? rate(counter.uncertain, counter.n) : null,
  };
}

export class LiveProbesStore {
  private scenarioName: LiveProbeScenario = "fresh";
  private counters: ProbeCounter[] = countersFor("fresh");
  private lastIngestedMs: number | null = null;
  private ingestedItems = 0;

  get scenario(): LiveProbeScenario {
    return this.scenarioName;
  }

  get totalIngested(): number {
    return this.ingestedItems;
  }

  setScenario(scenario: LiveProbeScenario): void {
    this.scenarioName = scenario;
    this.counters = countersFor(scenario);
    this.ingestedItems = 0;
    this.lastIngestedMs = scenario === "stale" ? Date.now() - STALE_AGE_MS : null;
  }

  ingest(items: number): void {
    if (this.scenarioName === "none") {
      this.scenarioName = "fresh";
      this.counters = emptyCounters();
    }
    const gradable = this.counters.filter((counter) => counter.gradable);
    for (let index = 0; index < items; index += 1) {
      const counter = gradable[index % gradable.length];
      if (counter === undefined) {
        break;
      }
      const roll = stableUnit("live-probe-ingest", counter.probeId, counter.n);
      counter.n += 1;
      if (roll < counter.passChance) {
        counter.passes += 1;
      } else if (roll < counter.passChance + counter.uncertainChance) {
        counter.uncertain += 1;
      }
    }
    this.ingestedItems += items;
    this.lastIngestedMs = Date.now();
  }

  read(): LiveProbes | null {
    if (this.scenarioName === "none") {
      return null;
    }
    const lastMs = this.lastIngestedMs ?? Date.now() - FRESH_AGE_MS;
    return {
      window_hours: LIVE_PROBES_WINDOW_HOURS,
      by_probe: this.counters.map(statOf),
      last_ingested_at: new Date(lastMs).toISOString(),
    };
  }

  reset(): void {
    this.setScenario("fresh");
  }
}

export const liveProbes = new LiveProbesStore();

mockState.stageTwo.onReset(() => liveProbes.reset());
