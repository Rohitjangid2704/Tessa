"use client";

import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/states/empty-state";
import type { VerdictStatus } from "@/components/status/status-types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  INVARIANT_STATUS_ORDER,
  INVARIANT_STATUS_PRESENTATION,
  InvariantCountChips,
} from "@/features/invariants/components/invariant-status-badge";
import {
  INVARIANT_CHECK_LABELS,
  INVARIANT_PACK_LABELS,
  INVARIANT_PACKS,
} from "@/features/invariants/labels";
import { indexInvariants, invariantCatalogQuery } from "@/features/invariants/queries";
import type { InvariantInfo, InvariantPack, InvariantStats } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { useRunStreamState } from "../use-run-stream";
import { InvariantResultsList } from "./invariant-results-list";

const NO_CATALOG: ReadonlyMap<string, InvariantInfo> = new Map();

export type InvariantPanelProps = {
  runId: string;
  invariants: readonly InvariantStats[];
};

interface PackGroup {
  pack: InvariantPack;
  items: InvariantStats[];
}

export function groupByPack(invariants: readonly InvariantStats[]): PackGroup[] {
  return INVARIANT_PACKS.flatMap((pack) => {
    const items = invariants.filter((entry) => entry.pack === pack);
    return items.length === 0 ? [] : [{ pack, items }];
  });
}

function countsOf(stats: InvariantStats): Record<VerdictStatus, number> {
  return {
    pass: stats.pass,
    fail: stats.fail,
    flaky: stats.flaky,
    uncertain: stats.uncertain,
    skipped: stats.skipped,
  };
}

type InvariantRowProps = {
  stats: InvariantStats;
  info: InvariantInfo | undefined;
  selected: boolean;
  onSelect: (invariantId: string) => void;
};

function InvariantRow({ stats, info, selected, onSelect }: InvariantRowProps) {
  return (
    <li data-slot="invariant-row" data-invariant-id={stats.invariant_id}>
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => onSelect(stats.invariant_id)}
        className={cn(
          "flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border px-3 py-2 text-left outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50",
          selected && "border-foreground/40 bg-muted",
        )}
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium wrap-break-word">
            {info?.title ?? stats.invariant_id}
          </span>
          <span className="text-xs wrap-break-word text-muted-foreground">
            <code className="font-mono">{stats.invariant_id}</code>
            {info === undefined ? null : `, ${INVARIANT_CHECK_LABELS[info.check]}`}
          </span>
        </span>
        <InvariantCountChips counts={countsOf(stats)} />
      </button>
    </li>
  );
}

function StatusFilter({
  value,
  onChange,
}: {
  value: VerdictStatus | null;
  onChange: (status: VerdictStatus | null) => void;
}) {
  return (
    <div role="group" aria-label="Filter results by status" className="flex flex-wrap gap-1.5">
      <Button
        type="button"
        size="sm"
        variant={value === null ? "default" : "outline"}
        aria-pressed={value === null}
        onClick={() => onChange(null)}
      >
        All
      </Button>
      {INVARIANT_STATUS_ORDER.map((status) => (
        <Button
          key={status}
          type="button"
          size="sm"
          variant={value === status ? "default" : "outline"}
          aria-pressed={value === status}
          onClick={() => onChange(value === status ? null : status)}
        >
          {INVARIANT_STATUS_PRESENTATION[status].label}
        </Button>
      ))}
    </div>
  );
}

export function InvariantPanel({ runId, invariants }: InvariantPanelProps) {
  const { isTerminal } = useRunStreamState();
  const catalogQuery = useQuery(invariantCatalogQuery());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<VerdictStatus | null>(null);

  const catalog = catalogQuery.data === undefined ? NO_CATALOG : indexInvariants(catalogQuery.data);
  const groups = groupByPack(invariants);

  if (invariants.length === 0) {
    return (
      <section aria-labelledby="invariants-heading" data-slot="invariant-panel">
        <h3 id="invariants-heading" className="sr-only">
          Invariants
        </h3>
        <EmptyState
          title="No invariants were checked"
          description={
            isTerminal
              ? "This run did not evaluate any invariants. Invariant packs come from the bundle and the plan."
              : "Invariant results appear here as scenarios finish."
          }
          icon={ShieldCheck}
          className="py-10"
        />
      </section>
    );
  }

  const selectedTitle = selectedId === null ? null : (catalog.get(selectedId)?.title ?? selectedId);

  function toggleInvariant(invariantId: string): void {
    setSelectedId((current) => (current === invariantId ? null : invariantId));
  }

  return (
    <section
      aria-labelledby="invariants-heading"
      data-slot="invariant-panel"
      className="flex flex-col gap-4"
    >
      <h3 id="invariants-heading" className="text-sm font-semibold">
        Invariants
      </h3>
      {catalogQuery.isError ? (
        <Alert role="status" data-slot="invariant-catalog-error">
          <AlertTitle>Invariant titles are unavailable</AlertTitle>
          <AlertDescription>
            <p>The catalog could not be loaded, so invariants are shown by id.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void catalogQuery.refetch()}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {groups.map((group) => (
        <div
          key={group.pack}
          role="group"
          aria-labelledby={`invariant-pack-${group.pack}`}
          data-slot="invariant-pack"
          data-pack={group.pack}
          className="flex flex-col gap-2"
        >
          <h4
            id={`invariant-pack-${group.pack}`}
            className="text-xs font-semibold text-muted-foreground uppercase"
          >
            {INVARIANT_PACK_LABELS[group.pack]}
          </h4>
          <ul className="flex flex-col gap-2">
            {group.items.map((stats) => (
              <InvariantRow
                key={stats.invariant_id}
                stats={stats}
                info={catalog.get(stats.invariant_id)}
                selected={selectedId === stats.invariant_id}
                onSelect={toggleInvariant}
              />
            ))}
          </ul>
        </div>
      ))}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h4 className="text-sm font-semibold" aria-live="polite">
            {selectedTitle === null ? "All results" : `Results for ${selectedTitle}`}
          </h4>
          <div className="flex flex-wrap items-center gap-2">
            <StatusFilter value={status} onChange={setStatus} />
            {selectedId === null ? null : (
              <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedId(null)}>
                Clear invariant filter
              </Button>
            )}
          </div>
        </div>
        <InvariantResultsList
          runId={runId}
          invariantId={selectedId}
          status={status}
          catalog={catalog}
        />
      </div>
    </section>
  );
}
