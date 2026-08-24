"use client";

import { Check, ChevronsUpDown, Search } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";
import { formatDateTime } from "@/components/date-time";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import type { RunSummary } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { shortRunId } from "../run-status";

export type RunPickerProps = {
  runs: readonly RunSummary[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
};

export function describeRunOption(run: RunSummary): string {
  const started = formatDateTime(run.created_at) ?? "Unknown time";
  return `${started}, run ${shortRunId(run.id)}`;
}

export function runOptionSearchText(run: RunSummary): string {
  return `${run.id} ${run.created_at} ${describeRunOption(run)}`.toLowerCase();
}

export function RunPicker({
  runs,
  selectedRunId,
  onSelect,
  isLoading,
  error,
  onRetry,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: RunPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();

  if (error !== null && error !== undefined) {
    return (
      <ErrorState
        title="Could not load runs to compare"
        description={describeApiError(error)}
        requestId={readRequestId(error)}
        onRetry={onRetry}
        className="py-6"
        data-slot="run-picker-error"
      />
    );
  }
  if (isLoading) {
    return (
      <div role="status" aria-busy="true" data-slot="run-picker-loading">
        <span className="sr-only">Loading runs to compare</span>
        <Skeleton className="h-8 w-72 max-w-full" />
      </div>
    );
  }

  const needle = query.trim().toLowerCase();
  const options = runs.filter((run) => needle === "" || runOptionSearchText(run).includes(needle));
  const selected = runs.find((run) => run.id === selectedRunId);
  const lastIndex = Math.max(0, options.length - 1);
  const active = Math.min(activeIndex, lastIndex);
  const activeOption = options[active];

  function changeOpen(next: boolean): void {
    setOpen(next);
    if (next) {
      setQuery("");
      setActiveIndex(0);
    }
  }

  function choose(runId: string): void {
    onSelect(runId);
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(Math.min(active + 1, lastIndex));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(Math.max(active - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(lastIndex);
    } else if (event.key === "Enter" && activeOption !== undefined) {
      event.preventDefault();
      choose(activeOption.id);
    }
  }

  return (
    <div data-slot="run-picker" className="flex flex-col gap-1.5">
      <span id={`${listId}-label`} className="text-sm font-medium">
        Compare against
      </span>
      <Popover open={open} onOpenChange={changeOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-labelledby={`${listId}-label ${listId}-value`}
            className="w-80 max-w-full justify-between"
          >
            <span id={`${listId}-value`} className="truncate">
              {selected !== undefined
                ? describeRunOption(selected)
                : selectedRunId === null
                  ? "Pick a completed run"
                  : `Run ${shortRunId(selectedRunId)}`}
            </span>
            <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-96 max-w-[calc(100vw-2rem)] gap-2 p-2">
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
            />
            <Input
              role="combobox"
              aria-label="Search completed runs"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={
                activeOption === undefined ? undefined : `${listId}-option-${active}`
              }
              placeholder="Search by date or run id"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleKeyDown}
              className="pl-8"
            />
          </div>
          {options.length === 0 ? (
            <p role="status" className="px-2 py-3 text-sm text-muted-foreground">
              {runs.length === 0
                ? "No other completed run of this plan yet."
                : "No completed run matches this search."}
            </p>
          ) : (
            <ul
              id={listId}
              role="listbox"
              aria-label="Completed runs of this plan"
              className="flex max-h-72 flex-col gap-0.5 overflow-y-auto"
            >
              {options.map((run, index) => (
                <li
                  key={run.id}
                  id={`${listId}-option-${index}`}
                  role="option"
                  aria-selected={run.id === selectedRunId}
                  data-active={index === active ? "true" : undefined}
                  data-run-id={run.id}
                  onClick={() => choose(run.id)}
                  onMouseMove={() => setActiveIndex(index)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                    index === active && "bg-muted",
                  )}
                >
                  <Check
                    aria-hidden="true"
                    className={cn(
                      "size-4 shrink-0",
                      run.id === selectedRunId ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{describeRunOption(run)}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {run.counters.pass} pass, {run.counters.fail} fail, {run.counters.flaky}{" "}
                      flaky, {run.counters.uncertain} uncertain, {run.counters.skipped} skipped
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {hasNextPage ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isFetchingNextPage}
              aria-busy={isFetchingNextPage}
              onClick={onLoadMore}
            >
              {isFetchingNextPage ? "Loading more runs" : "Load more runs"}
            </Button>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}
