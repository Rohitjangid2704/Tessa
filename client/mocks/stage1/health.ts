import type {
  HealthCheckStatus,
  HealthReport,
  HealthReportInterface,
} from "../factories/environment";
import { UNREACHABLE_HOST_MARKERS } from "../fixtures/gracie-env";
import type { BundleRecord, EnvironmentEntry } from "./store";

export const TRUTH_PREFIX = "truth:";
export const TRUTH_KIND = "truth_source";

const HTTP_KINDS = new Set(["http", "sse", "browser"]);
const STATUS_PRIORITY: Record<HealthCheckStatus, number> = {
  failed: 3,
  ok: 2,
  skipped: 1,
  unchecked: 0,
};
const BASE_LATENCY_MS = 20;
const UNREACHABLE_MESSAGE = "Connection refused or host unreachable";

interface Outcome {
  status: HealthCheckStatus;
  latency_ms: number | null;
  message: string | null;
}

interface Probe {
  variable: EnvironmentEntry | null;
  outcome: Outcome;
}

function skipped(message: string): Outcome {
  return { status: "skipped", latency_ms: null, message };
}

function isUnreachable(value: string): boolean {
  const lowered = value.toLowerCase();
  return UNREACHABLE_HOST_MARKERS.some((marker) => lowered.includes(marker));
}

function probeValue(value: string, okMessage: string, seed: string): Outcome {
  if (isUnreachable(value)) {
    return { status: "failed", latency_ms: null, message: UNREACHABLE_MESSAGE };
  }
  return { status: "ok", latency_ms: BASE_LATENCY_MS + seed.length, message: okMessage };
}

function missingValue(variable: EnvironmentEntry): Probe {
  return { variable, outcome: skipped(`No value set for ${variable.name}`) };
}

function probeInterface(kind: string, linked: readonly EnvironmentEntry[]): Probe[] {
  const probes: Probe[] = [];
  if (HTTP_KINDS.has(kind)) {
    const urlRows = linked.filter((row) => row.kind === "url");
    const valued = urlRows.find((row) => row.value !== null);
    if (valued?.value !== undefined && valued.value !== null) {
      probes.push({ variable: valued, outcome: probeValue(valued.value, "HTTP 200", valued.name) });
    } else {
      const first = urlRows[0];
      probes.push({
        variable: null,
        outcome: skipped(
          first === undefined
            ? "No URL variable with a value is linked to this interface"
            : `No value set for ${first.name}`,
        ),
      });
    }
    for (const row of urlRows) {
      if (row.value === null) {
        probes.push(missingValue(row));
      }
    }
  } else {
    probes.push({ variable: null, outcome: skipped(`Interface kind ${kind} is not checked yet`) });
  }
  for (const row of linked.filter((candidate) => candidate.kind === "dsn")) {
    probes.push(
      row.value === null
        ? missingValue(row)
        : { variable: row, outcome: probeValue(row.value, "SELECT 1 succeeded", row.name) },
    );
  }
  return probes;
}

function combine(outcomes: readonly Outcome[]): Outcome {
  if (outcomes.length === 0) {
    return skipped("Nothing to check");
  }
  const chosen = outcomes.reduce((best, candidate) =>
    STATUS_PRIORITY[candidate.status] > STATUS_PRIORITY[best.status] ? candidate : best,
  );
  const latencies = outcomes.flatMap((outcome) =>
    outcome.latency_ms === null ? [] : [outcome.latency_ms],
  );
  const messages = [
    ...new Set(outcomes.flatMap((outcome) => (outcome.message === null ? [] : [outcome.message]))),
  ];
  return {
    status: chosen.status,
    latency_ms: latencies.length > 0 ? Math.max(...latencies) : null,
    message: messages.length > 0 ? messages.join("; ") : null,
  };
}

export function knownInterfaceIds(record: BundleRecord): string[] {
  return [
    ...record.interfaces.map((entry) => entry.id),
    ...record.truthSources.map((entry) => `${TRUTH_PREFIX}${entry.id}`),
  ];
}

export interface HealthRun {
  record: BundleRecord;
  environment: EnvironmentEntry[];
  previous: HealthReport | null;
  targetId: string;
  selected: ReadonlySet<string> | null;
  checkedAt: string;
}

export function runHealthChecks(run: HealthRun): HealthReport {
  const { record, environment, selected, checkedAt } = run;
  const current = environment.filter((row) => !row.stale);
  const fresh = new Map<string, HealthReportInterface>();

  const recordInterface = (
    id: string,
    kind: string,
    linked: readonly EnvironmentEntry[],
    probes: Probe[],
  ) => {
    for (const probe of probes) {
      if (probe.variable !== null) {
        probe.variable.health = { ...probe.outcome, checked_at: checkedAt };
      }
    }
    const combined = combine(probes.map((probe) => probe.outcome));
    fresh.set(id, {
      interface_id: id,
      kind,
      status: combined.status,
      latency_ms: combined.latency_ms,
      message: combined.message,
      variables: linked.map((row) => row.name),
    });
  };

  for (const entry of record.interfaces) {
    if (selected !== null && !selected.has(entry.id)) {
      continue;
    }
    const linked = current.filter((row) => row.interface_ids.includes(entry.id));
    recordInterface(entry.id, entry.kind, linked, probeInterface(entry.kind, linked));
  }
  for (const truth of record.truthSources) {
    const id = `${TRUTH_PREFIX}${truth.id}`;
    if (selected !== null && !selected.has(id)) {
      continue;
    }
    const variable = current.find((row) => row.name === truth.connection_env) ?? null;
    const probe: Probe =
      variable === null || variable.value === null
        ? variable === null
          ? { variable: null, outcome: skipped("No connection variable is declared") }
          : missingValue(variable)
        : { variable, outcome: probeValue(variable.value, "SELECT 1 succeeded", variable.name) };
    recordInterface(id, TRUTH_KIND, variable === null ? [] : [variable], [probe]);
  }

  const known = knownInterfaceIds(record);
  const previousById = new Map(
    (run.previous?.interfaces ?? []).map((entry) => [entry.interface_id, entry]),
  );
  const interfaces = known.flatMap((id) => {
    const entry = fresh.get(id) ?? previousById.get(id);
    return entry === undefined ? [] : [entry];
  });
  return { target_id: run.targetId, checked_at: checkedAt, interfaces };
}

export function overallHealth(report: HealthReport | null): HealthCheckStatus {
  if (report === null || report.interfaces.length === 0) {
    return "unchecked";
  }
  const statuses = new Set(report.interfaces.map((entry) => entry.status));
  if (statuses.has("failed")) {
    return "failed";
  }
  return statuses.has("ok") ? "ok" : "skipped";
}
