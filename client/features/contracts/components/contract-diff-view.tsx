"use client";

import { useQuery } from "@tanstack/react-query";
import { CircleCheck, CircleHelp, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { DateTime } from "@/components/date-time";
import { FilterBar, type FilterField } from "@/components/filter-bar";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { RunStatusBadge } from "@/components/status/run-status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { bundleDetailQuery } from "@/features/bundles/queries";
import { describeApiError } from "@/lib/api/errors";
import type { ContractCheck, VerdictStatus } from "@/lib/api/types";
import { useCan } from "@/lib/auth/can";
import { runRoutes } from "@/lib/routes";
import { useUrlFilters } from "@/lib/url-state";
import { describeStartCheckError } from "../errors";
import {
  buildItemRows,
  CONTRACT_VERDICT_ORDER,
  countVerdicts,
  describeCheckOutcome,
  filterKeyedItems,
  isCheckSettled,
  keyItems,
  progressFromCheck,
  type VerdictCounts,
} from "../model";
import { useStartContractCheck } from "../mutations";
import { contractCheckQuery, isContractNotFound } from "../queries";
import { contractItemFiltersCodec, type ContractItemFilterValues } from "../schemas";
import { useContractProgress } from "../use-contract-progress";
import { BundleChip } from "./bundle-chip";
import { ContractVerdictBadge, contractVerdictLabel } from "./contract-verdict-badge";
import { ContractDiffSkeleton, ContractNotFound } from "./contract-states";
import { ItemList } from "./item-list";
import { ProgressBlock } from "./progress-block";

const UNCERTAIN_ALERT_CLASSES =
  "border-verdict-uncertain-fg/25 bg-verdict-uncertain-bg text-verdict-uncertain-fg *:data-[slot=alert-description]:text-verdict-uncertain-fg";

const PASS_ALERT_CLASSES =
  "border-verdict-pass-fg/25 bg-verdict-pass-bg text-verdict-pass-fg *:data-[slot=alert-description]:text-verdict-pass-fg";

const VERDICT_FILTER_FIELDS: readonly FilterField<"verdict">[] = [
  {
    type: "multi",
    key: "verdict",
    label: "Verdict",
    options: CONTRACT_VERDICT_ORDER.map((verdict) => ({
      value: verdict,
      label: contractVerdictLabel(verdict),
    })),
  },
];

function CountChips({ counts }: { counts: VerdictCounts }) {
  const present = CONTRACT_VERDICT_ORDER.filter((verdict) => counts[verdict] > 0);
  if (present.length === 0) {
    return null;
  }
  return (
    <ul aria-label="Items by verdict" className="flex flex-wrap gap-3">
      {present.map((verdict: VerdictStatus) => (
        <li key={verdict} data-verdict={verdict} className="flex items-center gap-1.5">
          <ContractVerdictBadge verdict={verdict} />
          <span className="text-sm tabular-nums">{counts[verdict]}</span>
        </li>
      ))}
    </ul>
  );
}

function RunAgainButton({ check }: { check: ContractCheck }) {
  const canStart = useCan("contracts.check");
  const { start, isPending, error } = useStartContractCheck();
  const problem = error === null ? null : describeStartCheckError(error);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={!canStart || isPending}
          aria-busy={isPending}
          onClick={() =>
            start({
              consumer_bundle_id: check.consumer_bundle_id,
              provider_bundle_id: check.provider_bundle_id,
            })
          }
        >
          {isPending ? "Starting the check" : "Run the check again"}
        </Button>
        {canStart ? null : (
          <p className="text-sm text-muted-foreground">Starting a check needs the member role.</p>
        )}
      </div>
      {problem === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problem.title}. {problem.message}
          {problem.requestId === null ? "" : ` (request ${problem.requestId})`}
        </p>
      )}
    </div>
  );
}

function BelowBarNotices({ check }: { check: ContractCheck }) {
  const consumer = useQuery(bundleDetailQuery(check.consumer_bundle_id));
  const provider = useQuery(bundleDetailQuery(check.provider_bundle_id));
  const sides = [
    { role: "consumer", bundle: consumer.data },
    { role: "provider", bundle: provider.data },
  ].flatMap(({ role, bundle }) =>
    bundle !== undefined && bundle.completeness.status === "below_bar" ? [{ role, bundle }] : [],
  );
  if (sides.length === 0) {
    return null;
  }
  return (
    <div data-slot="below-bar-notices" className="flex flex-col gap-3">
      {sides.map(({ role, bundle }) => (
        <Alert key={role} role="status" data-side={role}>
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>The {role} bundle is below the completeness bar</AlertTitle>
          <AlertDescription>
            <p>
              Version {bundle.version} scored {bundle.completeness.score} of 100. Calls or
              interfaces it leaves out cannot be compared, so this result may miss differences.
            </p>
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
}

function OutcomeBanners({ check, counts }: { check: ContractCheck; counts: VerdictCounts }) {
  const outcome = describeCheckOutcome(check);
  if (outcome === "in_progress") {
    return null;
  }
  return (
    <div data-slot="contract-outcome" data-outcome={outcome} className="flex flex-col gap-3">
      {outcome === "unfinished" ? (
        <Alert variant="destructive" data-slot="contract-unfinished">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>The check did not finish</AlertTitle>
          <AlertDescription>
            <p>
              The run ended as {check.status.replace("_", " ")}, so the items below are only the
              ones compared before it stopped. Run the check again for a full result.
            </p>
            <RunAgainButton check={check} />
          </AlertDescription>
        </Alert>
      ) : null}
      {counts.fail > 0 ? (
        <Alert variant="destructive" role="status" data-slot="contract-breaking">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>
            {counts.fail} {counts.fail === 1 ? "item breaks" : "items break"} the consumer
          </AlertTitle>
          <AlertDescription>
            <p>
              The consumer sends something the provider will reject or misread. The differences are
              listed below, breaking items first.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
      {counts.uncertain > 0 ? (
        <Alert role="status" data-slot="contract-uncertain" className={UNCERTAIN_ALERT_CLASSES}>
          <CircleHelp aria-hidden="true" />
          <AlertTitle>
            {counts.uncertain} {counts.uncertain === 1 ? "item" : "items"} could not be decided
          </AlertTitle>
          <AlertDescription>
            <p>
              Tessa cannot tell whether these are compatible. Treat them as unresolved, not as
              passing, and have someone who knows both apps look at them.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
      {outcome === "compatible" ? (
        <Alert role="status" data-slot="contract-compatible" className={PASS_ALERT_CLASSES}>
          <CircleCheck aria-hidden="true" />
          <AlertTitle>Compatible</AlertTitle>
          <AlertDescription>
            <p>
              {check.items.length === 0
                ? "The consumer declares no calls the provider could be compared against, so there was nothing to break."
                : "Every call the consumer declares matches an interface the provider accepts. No item breaks the consumer."}
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function CheckSummary({
  check,
  counts,
  inProgress,
}: {
  check: ContractCheck;
  counts: VerdictCounts;
  inProgress: boolean;
}) {
  const headlineId = useId();
  const outcome = describeCheckOutcome(check);

  return (
    <section
      aria-labelledby={headlineId}
      data-slot="contract-summary"
      data-outcome={outcome}
      className="flex flex-col gap-4 rounded-xl border bg-card p-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 id={headlineId} className="text-2xl font-semibold tracking-tight">
          <span data-slot="breaking-count" className="tabular-nums">
            {check.breaking}
          </span>{" "}
          breaking{inProgress ? " so far" : ""}
        </h2>
        <RunStatusBadge status={check.status} />
      </div>
      <CountChips counts={counts} />
      <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">Consumer (sends the calls)</dt>
          <dd>
            <BundleChip bundleId={check.consumer_bundle_id} showCompleteness />
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">Provider (accepts the calls)</dt>
          <dd>
            <BundleChip bundleId={check.provider_bundle_id} showCompleteness />
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">Started</dt>
          <dd>
            <DateTime value={check.created_at} />
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">Run</dt>
          <dd>
            <Link href={runRoutes.detail(check.run_id)} className="underline underline-offset-4">
              Open the run
            </Link>
          </dd>
        </div>
      </dl>
    </section>
  );
}

function ItemsSection({
  check,
  values,
  setVerdicts,
  resetVerdicts,
  activeCount,
  inProgress,
}: {
  check: ContractCheck;
  values: ContractItemFilterValues;
  setVerdicts: (patch: Partial<ContractItemFilterValues>) => void;
  resetVerdicts: () => void;
  activeCount: number;
  inProgress: boolean;
}) {
  const headingId = useId();
  const [toggledKeys, setToggledKeys] = useState<ReadonlySet<string>>(() => new Set());
  const keyed = keyItems(check.items);
  const visible = filterKeyedItems(keyed, values.verdict);
  const rows = buildItemRows(visible);

  function toggle(key: string): void {
    setToggledKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  return (
    <section aria-labelledby={headingId} data-slot="contract-items" className="flex flex-col gap-3">
      <h2 id={headingId} className="text-base font-semibold">
        Compared items
      </h2>
      <FilterBar
        label="Item filters"
        fields={VERDICT_FILTER_FIELDS}
        values={values}
        onChange={setVerdicts}
        onReset={resetVerdicts}
        activeCount={activeCount}
      />
      <p className="text-sm text-muted-foreground">
        Showing {visible.length} of {keyed.length} {keyed.length === 1 ? "item" : "items"}
        {inProgress ? ", more arrive as the check runs" : ""}
      </p>
      {keyed.length === 0 ? (
        <EmptyState
          title={inProgress ? "No items compared yet" : "Nothing was compared"}
          description={
            inProgress
              ? "Items appear here as the check compares each declared call."
              : "The consumer declares no calls this check could compare."
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState
          title="No items match the filter"
          description="Clear the verdict filter to see every compared item."
          action={
            <Button type="button" variant="outline" onClick={resetVerdicts}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <ItemList
          rows={rows}
          toggledKeys={toggledKeys}
          onToggle={toggle}
          label="Compared items grouped by interface"
        />
      )}
    </section>
  );
}

function CheckBody({ check }: { check: ContractCheck }) {
  const settled = isCheckSettled(check);
  const socketProgress = useContractProgress(check.run_id, !settled);
  const { values, activeCount, setFilters, resetFilters } = useUrlFilters(contractItemFiltersCodec);
  const counts = countVerdicts(check.items);
  const progress = socketProgress ?? progressFromCheck(check);

  return (
    <div data-slot="contract-diff-view" data-check-id={check.id} className="flex flex-col gap-6">
      <CheckSummary check={check} counts={counts} inProgress={!settled} />
      <BelowBarNotices check={check} />
      {settled ? null : <ProgressBlock progress={progress} />}
      <OutcomeBanners check={check} counts={counts} />
      <ItemsSection
        check={check}
        values={values}
        setVerdicts={(patch) => setFilters(patch)}
        resetVerdicts={() => resetFilters()}
        activeCount={activeCount}
        inProgress={!settled}
      />
    </div>
  );
}

export type ContractDiffViewProps = { contractCheckId: string };

export function ContractDiffView({ contractCheckId }: ContractDiffViewProps) {
  const query = useQuery(contractCheckQuery(contractCheckId));

  if (query.data !== undefined) {
    return <CheckBody key={query.data.id} check={query.data} />;
  }
  if (query.isError) {
    if (isContractNotFound(query.error)) {
      return <ContractNotFound />;
    }
    return (
      <ErrorState
        title="Could not load the contract check"
        description={describeApiError(query.error)}
        requestId={readRequestId(query.error)}
        onRetry={() => void query.refetch()}
      />
    );
  }
  return <ContractDiffSkeleton />;
}
