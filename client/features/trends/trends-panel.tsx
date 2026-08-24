"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { TrendingUp, TriangleAlert } from "lucide-react";
import { useId } from "react";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { savedPlansQuery } from "@/features/plans/queries";
import { shortRunId } from "@/features/runs/run-status";
import { CurrentTargetGate } from "@/features/targets/current-target-gate";
import { describeApiError } from "@/lib/api/errors";
import type { TrendMetric } from "@/lib/api/types";
import { useUrlFilters } from "@/lib/url-state";
import { TREND_METRIC_INFO, TREND_RANGE_LABELS } from "./labels";
import {
  MIN_TREND_POINTS,
  TREND_METRICS,
  TREND_RANGE_DAYS,
  trendSeriesQuery,
  type TrendRangeDays,
} from "./queries";
import { rangeDaysOf, trendFiltersCodec } from "./schemas";
import { TrendChart } from "./trend-chart";

const ALL_PLANS = "all";

const RANGE_PARAM = { 7: "7", 30: "30", 90: "90" } as const satisfies Record<
  TrendRangeDays,
  "7" | "30" | "90"
>;

type TrendCardProps = {
  metric: TrendMetric;
  targetId: string;
  rangeDays: TrendRangeDays;
  planId: string | null;
};

function TrendCardBody({ metric, targetId, rangeDays, planId }: TrendCardProps) {
  const query = useQuery(trendSeriesQuery(targetId, metric, rangeDays, planId));

  if (query.isPending) {
    return (
      <div role="status" aria-busy="true" data-slot="trend-loading">
        <span className="sr-only">Loading {TREND_METRIC_INFO[metric].label}</span>
        <Skeleton className="h-60 w-full" />
      </div>
    );
  }
  if (query.isError) {
    const requestId = readRequestId(query.error);
    return (
      <Alert variant="destructive" data-slot="trend-error">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>Could not load this chart</AlertTitle>
        <AlertDescription>
          <p>{describeApiError(query.error)}</p>
          {requestId === null ? null : (
            <p className="mt-1 font-mono text-xs">Request ID: {requestId}</p>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void query.refetch()}
          >
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (query.data.points.length < MIN_TREND_POINTS) {
    return (
      <div
        role="status"
        data-slot="trend-empty"
        className="flex flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-10 text-center"
      >
        <TrendingUp aria-hidden="true" className="size-5 text-muted-foreground" />
        <p className="text-sm font-medium">Not enough runs yet</p>
        <p className="text-xs text-muted-foreground">
          A trend needs at least {MIN_TREND_POINTS} runs in this range. Run the plan again or pick
          a longer range.
        </p>
      </div>
    );
  }
  return <TrendChart metric={metric} points={query.data.points} />;
}

function TrendCard(props: TrendCardProps) {
  const headingId = useId();
  const info = TREND_METRIC_INFO[props.metric];
  return (
    <section
      aria-labelledby={headingId}
      data-slot="trend-card"
      data-metric={props.metric}
      className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4"
    >
      <div className="flex flex-col gap-0.5">
        <h3 id={headingId} className="text-sm font-semibold">
          {info.label}
        </h3>
        <p className="text-xs text-muted-foreground">{info.description}</p>
      </div>
      <TrendCardBody {...props} />
    </section>
  );
}

type RangePickerProps = {
  value: TrendRangeDays;
  onChange: (days: TrendRangeDays) => void;
};

function RangePicker({ value, onChange }: RangePickerProps) {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="text-sm font-medium">
        Range
      </span>
      <div role="group" aria-labelledby={labelId} className="flex gap-1.5">
        {TREND_RANGE_DAYS.map((days) => (
          <Button
            key={days}
            type="button"
            size="sm"
            variant={value === days ? "default" : "outline"}
            aria-pressed={value === days}
            onClick={() => onChange(days)}
          >
            {TREND_RANGE_LABELS[days]}
          </Button>
        ))}
      </div>
    </div>
  );
}

type PlanFilterProps = {
  targetId: string;
  value: string | undefined;
  onChange: (planId: string | undefined) => void;
};

function PlanFilter({ targetId, value, onChange }: PlanFilterProps) {
  const triggerId = useId();
  const plans = useInfiniteQuery(savedPlansQuery(targetId));
  const items = plans.data?.items ?? [];
  const selected = items.find((plan) => plan.id === value);
  const triggerText =
    value === undefined ? "All plans" : (selected?.name ?? `Plan ${shortRunId(value)}`);

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={triggerId}>Plan</Label>
      <Select
        value={value ?? ALL_PLANS}
        onValueChange={(next) => onChange(next === ALL_PLANS ? undefined : next)}
      >
        <SelectTrigger id={triggerId} className="w-56 max-w-full">
          <SelectValue>{triggerText}</SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          <SelectItem value={ALL_PLANS}>All plans</SelectItem>
          {items.map((plan) => (
            <SelectItem key={plan.id} value={plan.id}>
              {plan.name ?? `Plan ${shortRunId(plan.id)}`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function TrendsContent({ targetId }: { targetId: string }) {
  const { values, setFilters } = useUrlFilters(trendFiltersCodec);
  const rangeDays = rangeDaysOf(values.range);
  const planId = values.plan_id ?? null;

  return (
    <div data-slot="trends-panel" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <RangePicker
          value={rangeDays}
          onChange={(days) => setFilters({ range: RANGE_PARAM[days] })}
        />
        <PlanFilter
          targetId={targetId}
          value={values.plan_id}
          onChange={(next) => setFilters({ plan_id: next })}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {TREND_METRICS.map((metric) => (
          <TrendCard
            key={metric}
            metric={metric}
            targetId={targetId}
            rangeDays={rangeDays}
            planId={planId}
          />
        ))}
      </div>
    </div>
  );
}

export function TrendsPanel() {
  return (
    <CurrentTargetGate
      title="Choose a target to see its trends"
      description="Trends are drawn per target. Pick one to see how its runs change over time."
    >
      {(targetId) => <TrendsContent targetId={targetId} />}
    </CurrentTargetGate>
  );
}
