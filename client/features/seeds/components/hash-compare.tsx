"use client";

import { CircleCheck, CircleHelp, CircleX } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { StatusBadge, type StatusBadgeProps } from "@/components/status/status-badge";
import { cn } from "@/lib/utils";
import {
  describeHashState,
  HASH_SOURCE_LABELS,
  HASH_STATE_LABELS,
  hashStateOf,
  NOT_CHECKED_YET,
  NOT_RECORDED_YET,
  type HashState,
} from "../hash-state";
import type { SeedHashSource } from "../types";

const statePresentation = {
  match: { tone: "verdict-pass", icon: CircleCheck },
  mismatch: { tone: "verdict-fail", icon: CircleX },
  unknown: { tone: "verdict-uncertain", icon: CircleHelp },
} as const satisfies Record<HashState, Pick<StatusBadgeProps, "tone" | "icon">>;

export function HashStateBadge({
  state,
  ...props
}: { state: HashState } & Omit<StatusBadgeProps, "tone" | "label" | "icon">) {
  return <StatusBadge {...statePresentation[state]} label={HASH_STATE_LABELS[state]} {...props} />;
}

interface HashColumnProps {
  label: string;
  hash: string | null;
  emptyText: string;
  caption: string | null;
  differs: boolean;
}

function HashColumn({ label, hash, emptyText, caption, differs }: HashColumnProps) {
  return (
    <div
      data-slot="hash-column"
      data-differs={differs}
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-lg border p-3",
        differs && "border-verdict-fail-fg/40",
      )}
    >
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</h3>
      {hash === null ? (
        <p data-slot="hash-empty" className="text-sm text-muted-foreground italic">
          {emptyText}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <code data-slot="hash-value" className="font-mono text-sm break-all">
            {hash}
          </code>
          <CopyButton
            text={hash}
            subject={`${label.toLowerCase()} hash`}
            variant="ghost"
            size="xs"
          />
        </div>
      )}
      {caption === null ? null : (
        <p data-slot="hash-source" className="text-xs text-muted-foreground">
          {caption}
        </p>
      )}
    </div>
  );
}

export interface HashCompareProps {
  declared: string | null;
  observed: string | null;
  hashSource: SeedHashSource | null;
  declaredLabel?: string;
  observedLabel?: string;
  className?: string;
}

export function HashCompare({
  declared,
  observed,
  hashSource,
  declaredLabel = "Declared",
  observedLabel = "Observed",
  className,
}: HashCompareProps) {
  const hashes = { declared, observed };
  const state = hashStateOf(hashes);
  return (
    <section
      data-slot="hash-compare"
      data-state={state}
      aria-label="Declared and observed hash"
      className={cn("flex flex-col gap-3", className)}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <HashColumn
          label={declaredLabel}
          hash={declared}
          emptyText={NOT_RECORDED_YET}
          caption={hashSource === null ? null : `Source: ${HASH_SOURCE_LABELS[hashSource]}`}
          differs={false}
        />
        <HashColumn
          label={observedLabel}
          hash={observed}
          emptyText={NOT_CHECKED_YET}
          caption={null}
          differs={state === "mismatch"}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <HashStateBadge state={state} />
        <p role="status" data-slot="hash-state-text">
          {describeHashState(state, hashes)}
        </p>
      </div>
    </section>
  );
}
