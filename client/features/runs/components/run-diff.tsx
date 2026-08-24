"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Equal, GitCompareArrows, History } from "lucide-react";
import Link from "next/link";
import { Suspense, useState } from "react";
import { PageHeader } from "@/components/app-shell/page-header";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { VerdictBadge } from "@/components/status/verdict-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { describeApiError, isApiError } from "@/lib/api/errors";
import type { RunDiff, RunDiffCategory, RunDiffItem, Verdict } from "@/lib/api/types";
import { runRoutes, withQuery } from "@/lib/routes";
import { useUrlFilters } from "@/lib/url-state";
import {
  isIdenticalDiff,
  olderRunsOf,
  RUN_DIFF_PICKER_PAGE_SIZE,
  runDiffQuery,
} from "../diff-queries";
import { runsListQuery } from "../queries";
import { formatCount, formatSignedMilliseconds, formatSignedUsd } from "../results-format";
import { shortRunId } from "../run-status";
import { runDiffCodec } from "../tab-schemas";
import { useRunStreamState } from "../use-run-stream";
import {
  CHANGE_CATEGORIES,
  DIFF_CATEGORY_PRESENTATION,
  DiffCategoryBadge,
} from "./diff-category-badge";
import { RunPicker } from "./run-picker";
import { RunLoading, RunNotFound } from "./run-screen";
import { SkipReasonBadge } from "./skip-reason-badge";

type RowFilter = "changes" | RunDiffCategory;

const CATEGORY_ORDER: Record<RunDiffCategory, number> = {
  new_failure: 0,
  still_failing: 1,
  flaky_change: 2,
  fixed: 3,
  unchanged: 4,
  added: 5,
  removed: 6,
  not_comparable: 7,
};

function sortItems(items: readonly RunDiffItem[]): RunDiffItem[] {
  return [...items].sort(
    (left, right) =>
      CATEGORY_ORDER[left.category] - CATEGORY_ORDER[right.category] ||
      left.title.localeCompare(right.title) ||
      left.role.localeCompare(right.role) ||
      left.interface_id.localeCompare(right.interface_id),
  );
}

function scenarioInRunHref(runId: string, item: RunDiffItem) {
  return withQuery(runRoutes.detail(runId), {
    tab: "scenarios",
    family: item.family,
    role: item.role,
  });
}

function VerdictCell({ verdict }: { verdict: Verdict | null }) {
  if (verdict === null) {
    return <span className="text-muted-foreground">None</span>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <VerdictBadge verdict={verdict.status} />
      {verdict.skip_reason === null ? null : <SkipReasonBadge reason={verdict.skip_reason} />}
    </span>
  );
}

type ScenarioCellProps = {
  runId: string;
  againstRunId: string;
  item: RunDiffItem;
};

function ScenarioCell({ runId, againstRunId, item }: ScenarioCellProps) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="font-medium wrap-break-word">{item.title}</span>
      <span className="text-xs wrap-break-word text-muted-foreground">
        {item.role} on {item.interface_id}, {item.family}
      </span>
      <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {item.run_scenario_id === null ? null : (
          <Link
            href={scenarioInRunHref(runId, item)}
            data-run-scenario-id={item.run_scenario_id}
            className="font-medium underline underline-offset-4"
          >
            Open in this run
          </Link>
        )}
        {item.against_run_scenario_id === null ? null : (
          <Link
            href={scenarioInRunHref(againstRunId, item)}
            data-run-scenario-id={item.against_run_scenario_id}
            className="font-medium underline underline-offset-4"
          >
            Open in the other run
          </Link>
        )}
      </span>
    </div>
  );
}

type DiffTableProps = {
  items: readonly RunDiffItem[];
  runId: string;
  againstRunId: string;
  label: string;
};

function DiffTable({ items, runId, againstRunId, label }: DiffTableProps) {
  return (
    <Table data-slot="diff-table" aria-label={label}>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Scenario</TableHead>
          <TableHead scope="col">Change</TableHead>
          <TableHead scope="col">Other run</TableHead>
          <TableHead scope="col">This run</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow
            key={`${item.scenario_id}:${item.role}:${item.interface_id}`}
            data-category={item.category}
            data-scenario-id={item.scenario_id}
          >
            <TableCell className="max-w-md align-top">
              <ScenarioCell runId={runId} againstRunId={againstRunId} item={item} />
            </TableCell>
            <TableCell className="align-top">
              <DiffCategoryBadge category={item.category} />
            </TableCell>
            <TableCell className="align-top">
              <VerdictCell verdict={item.before} />
            </TableCell>
            <TableCell className="align-top">
              <VerdictCell verdict={item.after} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function DeltaTile({ label, value }: { label: string; value: string }) {
  return (
    <div
      data-slot="diff-delta"
      className="flex min-w-0 flex-col gap-1 rounded-xl border bg-card px-4 py-3"
    >
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function listLengthOf(diff: RunDiff, category: (typeof CHANGE_CATEGORIES)[number]): number {
  switch (category) {
    case "new_failure":
      return diff.new_failures.length;
    case "fixed":
      return diff.fixed.length;
    case "still_failing":
      return diff.still_failing.length;
    case "flaky_change":
      return diff.flaky_changes.length;
  }
}

type FilterChipsProps = {
  diff: RunDiff;
  unchangedCount: number;
  value: RowFilter;
  onChange: (value: RowFilter) => void;
};

function FilterChips({ diff, unchangedCount, value, onChange }: FilterChipsProps) {
  const changeCount = CHANGE_CATEGORIES.reduce(
    (sum, category) => sum + listLengthOf(diff, category),
    0,
  );
  return (
    <div role="group" aria-label="Filter changes" className="flex flex-wrap gap-1.5">
      <Button
        type="button"
        size="sm"
        variant={value === "changes" ? "default" : "outline"}
        aria-pressed={value === "changes"}
        onClick={() => onChange("changes")}
      >
        All changes ({formatCount(changeCount)})
      </Button>
      {CHANGE_CATEGORIES.map((category) => (
        <Button
          key={category}
          type="button"
          size="sm"
          variant={value === category ? "default" : "outline"}
          aria-pressed={value === category}
          onClick={() => onChange(value === category ? "changes" : category)}
        >
          {DIFF_CATEGORY_PRESENTATION[category].label} ({formatCount(listLengthOf(diff, category))})
        </Button>
      ))}
      <Button
        type="button"
        size="sm"
        variant={value === "unchanged" ? "default" : "outline"}
        aria-pressed={value === "unchanged"}
        onClick={() => onChange(value === "unchanged" ? "changes" : "unchanged")}
      >
        Unchanged ({formatCount(unchangedCount)})
      </Button>
    </div>
  );
}

function rowsFor(items: readonly RunDiffItem[], filter: RowFilter): RunDiffItem[] {
  const comparable = items.filter((item) => item.comparable);
  if (filter === "changes") {
    return comparable.filter((item) =>
      (CHANGE_CATEGORIES as readonly RunDiffCategory[]).includes(item.category),
    );
  }
  return comparable.filter((item) => item.category === filter);
}

type DiffResultProps = {
  diff: RunDiff;
  runId: string;
  againstRunId: string;
};

function DiffResult({ diff, runId, againstRunId }: DiffResultProps) {
  const [filter, setFilter] = useState<RowFilter>("changes");
  const sorted = sortItems(diff.items);
  const unchangedCount = diff.items.filter((item) => item.category === "unchanged").length;
  const rows = rowsFor(sorted, filter);
  const notCompared = sorted.filter((item) => !item.comparable);

  return (
    <div data-slot="diff-result" className="flex flex-col gap-6">
      <dl className="grid gap-3 sm:grid-cols-2">
        <DeltaTile label="Cost change" value={formatSignedUsd(diff.cost_delta_usd)} />
        <DeltaTile
          label="p50 latency change"
          value={formatSignedMilliseconds(diff.latency_p50_delta_ms)}
        />
      </dl>
      {diff.items.length === 0 ? (
        <EmptyState
          title="Nothing to compare"
          description="The two runs have no scenarios in common."
          icon={GitCompareArrows}
        />
      ) : isIdenticalDiff(diff) ? (
        <EmptyState
          title="These runs are identical"
          description="Every scenario has the same verdict in both runs. Cost and latency can still differ, as shown above."
          icon={Equal}
          data-slot="diff-identical"
        />
      ) : (
        <section aria-labelledby="diff-changes-heading" className="flex flex-col gap-3">
          <h3 id="diff-changes-heading" className="text-sm font-semibold">
            Verdict changes
          </h3>
          <FilterChips
            diff={diff}
            unchangedCount={unchangedCount}
            value={filter}
            onChange={setFilter}
          />
          {rows.length === 0 ? (
            <p role="status" className="text-sm text-muted-foreground">
              No scenarios in this group.
            </p>
          ) : (
            <DiffTable
              items={rows}
              runId={runId}
              againstRunId={againstRunId}
              label="Verdict changes between the two runs"
            />
          )}
        </section>
      )}
      {notCompared.length === 0 ? null : (
        <section
          aria-labelledby="diff-not-compared-heading"
          data-slot="diff-not-compared"
          className="flex flex-col gap-3"
        >
          <h3 id="diff-not-compared-heading" className="text-sm font-semibold">
            Not compared ({formatCount(notCompared.length)})
          </h3>
          <p className="text-sm text-muted-foreground">
            These scenarios are listed apart because only one run has them, or one of the runs
            skipped them or left them undecided. They are not counted as changes.
          </p>
          <DiffTable
            items={notCompared}
            runId={runId}
            againstRunId={againstRunId}
            label="Scenarios that could not be compared"
          />
        </section>
      )}
    </div>
  );
}

function DiffSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading the run diff</span>
      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

function RunDiffView({ runId }: { runId: string }) {
  const { run } = useRunStreamState();
  const { values, setFilters } = useUrlFilters(runDiffCodec);
  const planId = run?.plan_id ?? null;
  const candidates = useInfiniteQuery({
    ...runsListQuery(
      { plan_id: planId ?? undefined, status: ["completed"] },
      RUN_DIFF_PICKER_PAGE_SIZE,
    ),
    enabled: planId !== null,
  });
  const loadedRuns = candidates.data?.items ?? [];
  const pickable = loadedRuns.filter((candidate) => candidate.id !== runId);
  const defaultAgainst = run === undefined ? null : (olderRunsOf(loadedRuns, run)[0]?.id ?? null);
  const against = values.against ?? defaultAgainst;
  const diffQuery = useQuery(runDiffQuery(runId, against));
  const candidatesSettled = planId === null || candidates.isSuccess || candidates.isError;

  function pickRun(nextRunId: string): void {
    setFilters({ against: nextRunId }, { history: "push" });
  }

  const description =
    against === null
      ? "Compare this run with an earlier completed run of the same plan."
      : `Run ${shortRunId(runId)} compared with run ${shortRunId(against)}.`;

  function renderBody() {
    if (against === null) {
      if (!candidatesSettled) {
        return <DiffSkeleton />;
      }
      if (planId === null) {
        return (
          <EmptyState
            title="No baseline for this run"
            description="This run was not started from a plan, so there is no earlier run to compare it with."
            icon={History}
          />
        );
      }
      if (candidates.isError) {
        return null;
      }
      return (
        <EmptyState
          title="This is the first run of this plan"
          description="There is no earlier completed run of this plan to compare with yet. Once more runs finish, you can compare them here."
          icon={History}
          data-slot="diff-first-run"
        />
      );
    }
    if (diffQuery.isPending) {
      return <DiffSkeleton />;
    }
    if (diffQuery.isError) {
      return (
        <ErrorState
          title={
            isApiError(diffQuery.error) && diffQuery.error.status === 404
              ? "The run to compare with was not found"
              : "Could not load the run diff"
          }
          description={describeApiError(diffQuery.error)}
          requestId={readRequestId(diffQuery.error)}
          onRetry={() => void diffQuery.refetch()}
        />
      );
    }
    return <DiffResult diff={diffQuery.data} runId={runId} againstRunId={against} />;
  }

  return (
    <div data-slot="run-diff" className="flex flex-col gap-6">
      <PageHeader
        title="Run diff"
        description={description}
        actions={
          <Button asChild variant="outline">
            <Link href={runRoutes.tab(runId, "results")}>
              <ArrowLeft aria-hidden="true" data-icon="inline-start" />
              Back to the run
            </Link>
          </Button>
        }
        className="pb-0"
      />
      {planId === null ? null : (
        <RunPicker
          runs={pickable}
          selectedRunId={against}
          onSelect={pickRun}
          isLoading={candidates.isPending}
          error={candidates.isError ? candidates.error : null}
          onRetry={() => void candidates.refetch()}
          hasNextPage={candidates.hasNextPage}
          isFetchingNextPage={candidates.isFetchingNextPage}
          onLoadMore={() => void candidates.fetchNextPage()}
        />
      )}
      {renderBody()}
    </div>
  );
}

export function RunDiffScreen({ runId }: { runId: string }) {
  const { phase, error, retry } = useRunStreamState();
  switch (phase) {
    case "loading":
      return <RunLoading />;
    case "not_found":
      return <RunNotFound requestId={readRequestId(error)} />;
    case "error":
      return (
        <ErrorState
          title="Could not load the run"
          description={describeApiError(error)}
          requestId={readRequestId(error)}
          onRetry={retry}
        />
      );
    case "ready":
      return (
        <Suspense fallback={<RunLoading />}>
          <RunDiffView runId={runId} />
        </Suspense>
      );
  }
}
