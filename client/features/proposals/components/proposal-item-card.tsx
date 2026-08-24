"use client";

import { Undo2 } from "lucide-react";
import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { pluralize } from "@/features/bundles/format";
import { ConfidenceChip } from "@/features/catalog/components/confidence-chip";
import { coverageRoutes, scenarioRoutes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import {
  PROPOSAL_DEPTH_LABELS,
  PROPOSAL_KIND_LABELS,
  PROPOSAL_NEED_LABELS,
  PROPOSAL_REASON_LABELS,
} from "../labels";
import { isLocked } from "../selection";
import type { ProposalItem, ProposalItemChoice } from "../types";
import { ItemStatusBadge, RiskBadge } from "./proposal-badges";

export const DECLINE_NOTE_MAX_LENGTH = 300;
const MAX_SCENARIO_LINKS = 5;

export interface ProposalItemCardProps {
  item: ProposalItem;
  targetId: string;
  canEdit: boolean;
  pending: boolean;
  onChoose: (item: ProposalItem, choice: ProposalItemChoice, note?: string | null) => void;
}

export function describeEstimate(estimate: ProposalItem["estimate"]): string | null {
  if (estimate === null) {
    return null;
  }
  return `${pluralize(estimate.scenarios, "scenario")}, about ${estimate.minutes} min`;
}

function ReasonChips({ item }: { item: ProposalItem }) {
  return (
    <ul aria-label="Reasons" className="flex flex-wrap gap-1.5">
      {item.reasons.map((reason) => {
        const note = reason.note ?? null;
        const label = PROPOSAL_REASON_LABELS[reason.code];
        return (
          <li key={reason.code}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="secondary"
                  tabIndex={0}
                  data-slot="reason-chip"
                  data-reason={reason.code}
                >
                  {label}
                  {note === null ? null : <span className="sr-only">: {note}</span>}
                </Badge>
              </TooltipTrigger>
              {note === null ? null : <TooltipContent>{note}</TooltipContent>}
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}

function NeedChips({ item }: { item: ProposalItem }) {
  if (item.needs.length === 0) {
    return null;
  }
  return (
    <ul aria-label="Needs" className="flex flex-wrap gap-1.5">
      {item.needs.map((need) => (
        <li key={need}>
          <Badge variant="outline" data-slot="need-chip" data-need={need}>
            {PROPOSAL_NEED_LABELS[need]}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function LockedLinks({ item, targetId }: { item: ProposalItem; targetId: string }) {
  const cellCount = item.cell_ids.length;
  return (
    <div
      data-slot="proposal-locked"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
    >
      {item.scenario_ids.slice(0, MAX_SCENARIO_LINKS).map((scenarioId, index) => (
        <Link
          key={scenarioId}
          href={scenarioRoutes.detail(scenarioId)}
          aria-label={`Scenario ${index + 1} of ${item.title}`}
          className="underline underline-offset-4"
        >
          Scenario {index + 1}
        </Link>
      ))}
      <Link
        href={coverageRoutes.map(targetId, { area: item.area })}
        aria-label={`${cellCount === 0 ? "Coverage map" : pluralize(cellCount, "coverage cell")} for ${item.title}`}
        className="underline underline-offset-4"
      >
        {cellCount === 0 ? "Coverage map" : pluralize(cellCount, "coverage cell")}
      </Link>
      <span className="text-xs text-muted-foreground">
        {item.status === "authored"
          ? "Authored items can no longer be changed here."
          : "Every cell is covered."}
      </span>
    </div>
  );
}

interface DeclineFormProps {
  title: string;
  onSubmit: (note: string) => void;
  onCancel: () => void;
}

function DeclineForm({ title, onSubmit, onCancel }: DeclineFormProps) {
  const fieldId = useId();
  const [note, setNote] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSubmit(note);
  }

  return (
    <form
      onSubmit={handleSubmit}
      data-slot="decline-form"
      aria-label={`Decline ${title}`}
      className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3"
    >
      <Label htmlFor={fieldId}>Why decline it? (optional)</Label>
      <Textarea
        id={fieldId}
        value={note}
        maxLength={DECLINE_NOTE_MAX_LENGTH}
        onChange={(event) => setNote(event.target.value)}
        placeholder="For example: covered by the vendor contract tests"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" variant="destructive">
          Decline item
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {note.length} of {DECLINE_NOTE_MAX_LENGTH}
        </span>
      </div>
    </form>
  );
}

export function ProposalItemCard({
  item,
  targetId,
  canEdit,
  pending,
  onChoose,
}: ProposalItemCardProps) {
  const headingId = useId();
  const [declining, setDeclining] = useState(false);
  const locked = isLocked(item);
  const editable = canEdit && !locked;
  const estimate = describeEstimate(item.estimate);
  const selected = item.status === "selected";

  return (
    <article
      data-slot="proposal-item"
      data-item-id={item.id}
      data-area={item.area}
      data-status={item.status}
      data-risk={item.risk}
      data-pending={pending ? "true" : undefined}
      aria-labelledby={headingId}
      aria-busy={pending ? true : undefined}
      className={cn(
        "flex gap-3 rounded-xl border bg-card p-4 text-card-foreground",
        selected && "border-foreground/40",
        item.status === "declined" && "border-dashed",
        pending && "border-dotted",
      )}
    >
      {editable && (item.status === "proposed" || selected) ? (
        <Checkbox
          aria-label={`Select ${item.title}`}
          checked={selected}
          disabled={pending}
          onCheckedChange={(checked) => onChoose(item, checked === true ? "selected" : "proposed")}
          className="mt-1"
        />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <h4 id={headingId} className="min-w-0 text-sm font-semibold break-words">
            {item.title}
          </h4>
          <div className="flex flex-wrap items-center gap-1.5">
            <RiskBadge risk={item.risk} />
            <ItemStatusBadge status={item.status} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <Badge variant="outline" data-slot="kind-chip">
            {PROPOSAL_KIND_LABELS[item.kind]}
          </Badge>
          <Badge variant="outline" data-slot="depth-chip">
            {PROPOSAL_DEPTH_LABELS[item.depth]}
          </Badge>
          {estimate === null ? null : (
            <span data-slot="estimate" className="text-muted-foreground">
              {estimate}
            </span>
          )}
          <ConfidenceChip confidence={item.confidence} />
        </div>
        <ReasonChips item={item} />
        <NeedChips item={item} />
        {item.evidence === null ? null : (
          <p data-slot="evidence" className="text-xs text-muted-foreground">
            Evidence: <span className="font-mono break-all">{item.evidence}</span>
          </p>
        )}
        {item.note === null ? null : (
          <p data-slot="item-note" className="text-sm">
            <span className="font-medium">Note:</span> {item.note}
          </p>
        )}
        {locked ? <LockedLinks item={item} targetId={targetId} /> : null}
        {declining ? (
          <DeclineForm
            title={item.title}
            onCancel={() => setDeclining(false)}
            onSubmit={(note) => {
              setDeclining(false);
              onChoose(item, "declined", note);
            }}
          />
        ) : null}
        {editable && !declining && item.status === "declined" ? (
          <div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => onChoose(item, "proposed")}
              aria-label={`Restore ${item.title}`}
            >
              <Undo2 aria-hidden="true" data-icon="inline-start" />
              Restore
            </Button>
          </div>
        ) : null}
        {editable && !declining && item.status !== "declined" ? (
          <div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => setDeclining(true)}
              aria-label={`Decline ${item.title}`}
            >
              Decline
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  );
}
