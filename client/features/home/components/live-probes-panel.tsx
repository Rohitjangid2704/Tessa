"use client";

import { useQuery } from "@tanstack/react-query";
import { Radio, TriangleAlert } from "lucide-react";
import { Meter, type MeterTone } from "@/components/meter";
import { LastSeen } from "@/features/findings/components/last-seen";
import { useProbeBank } from "@/features/probes/queries";
import { formatCount, formatPercent } from "@/features/runs/results-format";
import type { LiveProbeStat, LiveProbes, Probe } from "@/lib/api/types";
import { useNow } from "@/lib/use-now";
import { loadStateOf } from "../load-state";
import {
  describeWindow,
  isTrafficStale,
  LIVE_PROBES_STALE_AFTER_MINUTES,
  liveProbesTone,
  probeRateState,
} from "../live-probes";
import { liveProbesQuery } from "../queries";
import { KpiTile } from "./kpi-tile";

const FRESHNESS_REFRESH_MS = 30_000;

export type LiveProbesPanelProps = {
  targetId: string | null;
  className?: string;
};

function NoTraffic() {
  return (
    <div data-slot="no-traffic" className="flex flex-col items-start gap-2">
      <p className="text-base font-medium">Connect production traffic</p>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Send production answers to <span className="font-mono">POST /api/v1/ingest/traffic</span>{" "}
        with the deployment&apos;s ingest key in the <span className="font-mono">X-Ingest-Key</span>{" "}
        header. Tessa grades them with the same probes and keeps counts only, unless the
        deployment is set to store text. This panel fills in after the first batch.
      </p>
    </div>
  );
}

function NoProbeResults({ windowHours }: { windowHours: number }) {
  return (
    <p data-slot="no-probe-results" className="text-sm text-muted-foreground">
      Traffic arrived, but no probe has a result in {describeWindow(windowHours)} yet.
    </p>
  );
}

type FreshnessProps = {
  lastIngestedAt: string | null;
  stale: boolean;
};

function Freshness({ lastIngestedAt, stale }: FreshnessProps) {
  if (lastIngestedAt === null) {
    return <p className="text-sm text-muted-foreground">No traffic time was recorded.</p>;
  }
  return (
    <div
      data-slot="live-probes-freshness"
      data-stale={stale ? "true" : "false"}
      className="text-sm"
    >
      <p className="text-muted-foreground">
        Last traffic{" "}
        <span className="font-medium text-foreground">
          <LastSeen value={lastIngestedAt} />
        </span>
      </p>
      {stale ? (
        <p role="status" data-slot="live-probes-stale" className="mt-1 flex items-start gap-1.5">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-kpi-warn-fg" />
          <span>
            No traffic for more than {LIVE_PROBES_STALE_AFTER_MINUTES} minutes, so these figures
            may be out of date.
          </span>
        </p>
      ) : null}
    </div>
  );
}

type RateBarProps = {
  name: string;
  probeLabel: string;
  rate: number | null;
  answers: number;
  tone: MeterTone;
};

function RateBar({ name, probeLabel, rate, answers, tone }: RateBarProps) {
  const text = `${formatPercent(rate)} of ${formatCount(answers)} answers`;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span>{name}</span>
        <span className="font-medium tabular-nums">{formatPercent(rate)}</span>
      </div>
      <Meter
        value={rate}
        label={`${probeLabel}: ${name.toLowerCase()} rate`}
        valueText={text}
        tone={tone}
        className="h-1.5"
      />
    </div>
  );
}

type ProbeRowProps = {
  stat: LiveProbeStat;
  probe: Probe | undefined;
};

function ProbeRow({ stat, probe }: ProbeRowProps) {
  const state = probeRateState(stat);
  const probeLabel = probe?.question ?? stat.probe_id;
  return (
    <li
      data-slot="live-probe"
      data-probe={stat.probe_id}
      data-state={state}
      className="flex flex-col gap-2 rounded-lg border p-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="text-sm font-medium wrap-anywhere">{probeLabel}</p>
          {probe === undefined ? null : (
            <p className="font-mono text-xs text-muted-foreground wrap-anywhere">
              {stat.probe_id}
            </p>
          )}
        </div>
        <p data-slot="live-probe-n" className="text-xs text-muted-foreground tabular-nums">
          {formatCount(stat.n)} {stat.n === 1 ? "answer" : "answers"}
        </p>
      </div>
      {state === "rated" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <RateBar
            name="Pass"
            probeLabel={probeLabel}
            rate={stat.pass_rate}
            answers={stat.n}
            tone="pass"
          />
          <RateBar
            name="Uncertain"
            probeLabel={probeLabel}
            rate={stat.uncertain_rate}
            answers={stat.n}
            tone="neutral"
          />
        </div>
      ) : null}
      {state === "ungraded" ? (
        <p data-slot="live-probe-error" className="flex items-start gap-1.5 text-sm">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-kpi-warn-fg" />
          <span>
            These answers were received but could not be graded, so this probe has no rates. If it
            persists, check the Laya connection under Settings.
          </span>
        </p>
      ) : null}
      {state === "no_answers" ? (
        <p className="text-sm text-muted-foreground">No answers for this probe in the window.</p>
      ) : null}
    </li>
  );
}

type ProbeListProps = {
  data: LiveProbes;
  probesById: ReadonlyMap<string, Probe>;
};

function ProbeList({ data, probesById }: ProbeListProps) {
  return (
    <ul aria-label="Live production probes" className="flex flex-col gap-3">
      {data.by_probe.map((stat) => (
        <ProbeRow key={stat.probe_id} stat={stat} probe={probesById.get(stat.probe_id)} />
      ))}
    </ul>
  );
}

type PanelBodyProps = {
  data: LiveProbes | null;
  probesById: ReadonlyMap<string, Probe>;
  stale: boolean;
};

function PanelBody({ data, probesById, stale }: PanelBodyProps) {
  if (data === null) {
    return <NoTraffic />;
  }
  return (
    <div data-slot="live-probes-body" className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Aggregates over {describeWindow(data.window_hours)}. Production text is never shown here.
      </p>
      <Freshness lastIngestedAt={data.last_ingested_at} stale={stale} />
      {data.by_probe.length === 0 ? (
        <NoProbeResults windowHours={data.window_hours} />
      ) : (
        <ProbeList data={data} probesById={probesById} />
      )}
    </div>
  );
}

export function LiveProbesPanel({ targetId, className }: LiveProbesPanelProps) {
  const probes = useQuery(liveProbesQuery(targetId));
  const bank = useProbeBank();
  const nowMs = useNow(FRESHNESS_REFRESH_MS);
  const data = probes.data ?? null;
  const stale = data !== null && isTrafficStale(data.last_ingested_at, nowMs);
  const { tone, statusLabel } = liveProbesTone(data, stale);

  return (
    <KpiTile
      title="Live production probes"
      icon={Radio}
      tone={tone}
      statusLabel={statusLabel}
      load={loadStateOf(probes)}
      className={className}
      data-tile="live-probes"
    >
      {probes.data === undefined ? null : (
        <PanelBody data={data} probesById={bank.byId} stale={stale} />
      )}
    </KpiTile>
  );
}
