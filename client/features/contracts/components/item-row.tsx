"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { StructuralDiff } from "@/components/structural-diff";
import { Button } from "@/components/ui/button";
import type { ContractDiff } from "@/lib/api/types";
import {
  countStructuralChanges,
  diffJson,
  type StructuralChangeCounts,
  type StructuralChangeKind,
} from "../diff-json";
import { CONTRACT_VERDICT_ORDER, type VerdictCounts } from "../model";
import { ContractVerdictBadge, contractVerdictLabel } from "./contract-verdict-badge";

export const RAW_JSON_MAX_CHARS = 20_000;

const KIND_LABELS: Partial<Record<StructuralChangeKind, string>> = {
  removed: "Only the consumer declares",
  added: "Only the provider accepts",
};

const COUNT_LABELS: Record<keyof StructuralChangeCounts, string> = {
  removed: "only in the consumer",
  added: "only in the provider",
  type_changed: "with a changed type",
  value_changed: "with a changed value",
  reordered: "reordered",
};

type RowPlacement = {
  index: number;
  position: number;
  total: number;
  offset: number;
  measureRef: (element: HTMLLIElement | null) => void;
};

export function describeChangeCounts(counts: StructuralChangeCounts): string {
  const parts = (Object.keys(COUNT_LABELS) as Array<keyof StructuralChangeCounts>)
    .filter((kind) => counts[kind] > 0)
    .map((kind) => `${counts[kind]} ${COUNT_LABELS[kind]}`);
  return parts.join(", ");
}

export function describeVerdictCounts(counts: VerdictCounts): string {
  return CONTRACT_VERDICT_ORDER.filter((verdict) => counts[verdict] > 0)
    .map((verdict) => `${counts[verdict]} ${contractVerdictLabel(verdict).toLowerCase()}`)
    .join(", ");
}

function formatRawJson(value: unknown): { text: string; truncated: boolean } {
  const full = JSON.stringify(value, null, 2) ?? "undefined";
  if (full.length <= RAW_JSON_MAX_CHARS) {
    return { text: full, truncated: false };
  }
  return { text: full.slice(0, RAW_JSON_MAX_CHARS), truncated: true };
}

function RawJsonPane({ caption, value }: { caption: string; value: unknown }) {
  const { text, truncated } = formatRawJson(value);
  return (
    <div data-slot="contract-raw-json" className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{caption}</p>
        <CopyButton text={JSON.stringify(value, null, 2) ?? ""} subject={caption} size="xs" />
      </div>
      <pre
        tabIndex={0}
        aria-label={`${caption}, raw JSON`}
        className="max-h-80 overflow-auto rounded-md border bg-background p-2 font-mono text-xs break-all whitespace-pre-wrap outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {text}
      </pre>
      {truncated ? (
        <p className="text-xs text-muted-foreground">
          Shown up to {RAW_JSON_MAX_CHARS} characters. Use Copy for the whole value.
        </p>
      ) : null}
    </div>
  );
}

export type ItemRowProps = RowPlacement & {
  rowKey: string;
  item: ContractDiff;
  expanded: boolean;
  onToggle: (key: string) => void;
};

export function ItemRow({
  rowKey,
  item,
  expanded,
  onToggle,
  index,
  position,
  total,
  offset,
  measureRef,
}: ItemRowProps) {
  const panelId = useId();
  const rawId = useId();
  const [showRaw, setShowRaw] = useState(false);
  const changes = diffJson(item.consumer_declares, item.provider_accepts);
  const counts = countStructuralChanges(changes);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const differenceText =
    changes.length === 0
      ? "no differences"
      : `${changes.length} ${changes.length === 1 ? "difference" : "differences"}`;

  return (
    <li
      ref={measureRef}
      data-slot="contract-item"
      data-index={index}
      data-verdict={item.verdict}
      data-interface-id={item.interface_id}
      aria-posinset={position}
      aria-setsize={total}
      className="absolute top-0 left-0 w-full border-b bg-card"
      style={{ transform: `translateY(${offset}px)` }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? panelId : undefined}
        onClick={() => onToggle(rowKey)}
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-left text-sm outline-none hover:bg-muted/50 focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        <Chevron aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <ContractVerdictBadge verdict={item.verdict} />
        <code className="font-mono text-xs break-all">{item.path}</code>
        <span className="min-w-0 flex-1 basis-48 truncate text-muted-foreground">
          {item.message}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{differenceText}</span>
      </button>
      {expanded ? (
        <div id={panelId} className="flex flex-col gap-4 border-t bg-muted/30 px-3 py-3">
          <p className="text-sm break-words">{item.message}</p>
          <section className="flex flex-col gap-2">
            <h4 className="text-sm font-medium">Structural differences</h4>
            {changes.length > 0 ? (
              <p className="text-xs text-muted-foreground">{describeChangeCounts(counts)}</p>
            ) : null}
            <StructuralDiff
              changes={changes}
              caption={`Structural differences for ${item.interface_id} at ${item.path}`}
              beforeLabel="Consumer declares"
              afterLabel="Provider accepts"
              kindLabels={KIND_LABELS}
              emptyText="The consumer declares exactly what the provider accepts."
            />
          </section>
          <div className="flex flex-col gap-3">
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-expanded={showRaw}
                aria-controls={showRaw ? rawId : undefined}
                onClick={() => setShowRaw((current) => !current)}
              >
                {showRaw ? "Hide raw JSON" : "Show raw JSON"}
              </Button>
            </div>
            {showRaw ? (
              <div id={rawId} className="grid gap-3 md:grid-cols-2">
                <RawJsonPane caption="Consumer declares" value={item.consumer_declares} />
                <RawJsonPane caption="Provider accepts" value={item.provider_accepts} />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

export type GroupRowProps = RowPlacement & {
  interfaceId: string;
  counts: VerdictCounts;
};

export function GroupRow({
  interfaceId,
  counts,
  index,
  position,
  total,
  offset,
  measureRef,
}: GroupRowProps) {
  return (
    <li
      ref={measureRef}
      data-slot="contract-group"
      data-index={index}
      data-interface-id={interfaceId}
      aria-posinset={position}
      aria-setsize={total}
      className="absolute top-0 left-0 flex w-full flex-wrap items-baseline justify-between gap-2 border-b bg-muted px-3 py-2"
      style={{ transform: `translateY(${offset}px)` }}
    >
      <h3 className="text-sm font-semibold">
        <span className="font-normal text-muted-foreground">Interface </span>
        <code className="font-mono">{interfaceId}</code>
      </h3>
      <span className="text-xs text-muted-foreground">{describeVerdictCounts(counts)}</span>
    </li>
  );
}
