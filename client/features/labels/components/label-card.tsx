"use client";

import {
  CircleCheck,
  CircleHelp,
  CircleX,
  ExternalLink,
  EyeOff,
  SkipForward,
  Undo2,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useId, useState } from "react";
import { DateTime } from "@/components/date-time";
import { VerdictBadge } from "@/components/status/verdict-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Kbd } from "@/components/ui/kbd";
import type { LabelTask, LabelValue } from "@/lib/api/types";
import { runRoutes } from "@/lib/routes";
import {
  isAlwaysBlind,
  LABEL_REASON_HINTS,
  LABEL_REASON_LABELS,
  LABEL_SUBJECT_LABELS,
  LABEL_VALUE_LABELS,
} from "../schemas";
import { SHORTCUT_KEYS } from "../use-label-shortcuts";
import type { LastAnsweredCard } from "../use-label-queue";

export const EVIDENCE_PREVIEW_CHARS = 280;

const ANSWER_ICONS = {
  pass: CircleCheck,
  fail: CircleX,
  uncertain: CircleHelp,
} as const satisfies Record<LabelValue, unknown>;

const ANSWER_VALUES: readonly LabelValue[] = ["pass", "fail", "uncertain"];

export function clampConfidence(confidence: number): number {
  return Math.min(1, Math.max(0, confidence));
}

export function formatConfidence(confidence: number): string {
  return `${Math.round(clampConfidence(confidence) * 100)}%`;
}

export function stepHref(task: Pick<LabelTask, "run_id" | "step_id">): Route {
  return runRoutes.step(task.run_id, task.step_id);
}

interface EvidenceTextProps {
  text: string;
}

function EvidenceText({ text }: EvidenceTextProps) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const truncates = text.length > EVIDENCE_PREVIEW_CHARS;
  const shown =
    truncates && !expanded ? `${text.slice(0, EVIDENCE_PREVIEW_CHARS).trimEnd()}...` : text;
  return (
    <div className="flex flex-col items-start gap-1.5">
      <p
        id={bodyId}
        data-slot="evidence-text"
        className="max-h-80 w-full overflow-y-auto rounded-lg bg-muted/50 p-3 text-sm wrap-break-word whitespace-pre-wrap"
      >
        {shown}
      </p>
      {truncates ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show less" : `Show all ${text.length} characters`}
        </Button>
      ) : null}
    </div>
  );
}

interface MachineValueProps {
  task: LabelTask;
  visible: boolean;
}

function MachineValue({ task, visible }: MachineValueProps) {
  if (!visible) {
    return (
      <p
        data-slot="machine-value-hidden"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <EyeOff aria-hidden="true" className="size-4 shrink-0" />
        {isAlwaysBlind(task.reason)
          ? "Machine value stays hidden until you answer. Audit and disagreement cards are always blind."
          : "Machine value hidden until you answer, so it cannot anchor your verdict."}
      </p>
    );
  }
  if (task.machine_value === null) {
    return (
      <p className="text-sm text-muted-foreground">The machine gave no value for this task.</p>
    );
  }
  return (
    <p data-slot="machine-value" className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">Machine value</span>{" "}
      <VerdictBadge verdict={task.machine_value} />{" "}
      {task.machine_confidence === null ? null : (
        <span className="text-muted-foreground tabular-nums">
          {formatConfidence(task.machine_confidence)} confidence
        </span>
      )}
    </p>
  );
}

export interface AnsweredNoteProps {
  answered: LastAnsweredCard;
}

export function AnsweredNote({ answered }: AnsweredNoteProps) {
  const { task, value } = answered;
  return (
    <p
      data-slot="answered-note"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-muted/40 px-3 py-2 text-sm"
    >
      <span>You labeled</span> <VerdictBadge verdict={value} />{" "}
      <span className="text-muted-foreground">
        {task.machine_value === null ? "The machine gave no value." : "The machine said"}
      </span>{" "}
      {task.machine_value === null ? null : <VerdictBadge verdict={task.machine_value} />}{" "}
      {task.machine_confidence === null ? null : (
        <span className="text-muted-foreground tabular-nums">
          {formatConfidence(task.machine_confidence)} confidence
        </span>
      )}
    </p>
  );
}

export interface LabelCardProps {
  task: LabelTask;
  machineVisible: boolean;
  canLabel: boolean;
  readOnlyReason?: string;
  canUndo: boolean;
  onAnswer: (value: LabelValue) => void;
  onSkip: () => void;
  onUndo: () => void;
}

export function LabelCard({
  task,
  machineVisible,
  canLabel,
  readOnlyReason,
  canUndo,
  onAnswer,
  onSkip,
  onUndo,
}: LabelCardProps) {
  const headingId = useId();
  const evidenceHeadingId = useId();
  const readOnlyId = useId();

  return (
    <Card
      data-slot="label-card"
      data-task-id={task.id}
      data-reason={task.reason}
      className="max-w-3xl"
      role="region"
      aria-labelledby={headingId}
    >
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge variant="outline">{LABEL_REASON_LABELS[task.reason]}</Badge>
          <Badge variant="secondary">{LABEL_SUBJECT_LABELS[task.subject_type]}</Badge>
          <span className="text-xs text-muted-foreground">
            Queued <DateTime value={task.created_at} />
          </span>
        </div>
        <p className="-mt-2 text-xs text-muted-foreground">{LABEL_REASON_HINTS[task.reason]}</p>
        <h2 id={headingId} className="text-lg leading-snug font-semibold text-balance">
          {task.question}
        </h2>
        <section aria-labelledby={evidenceHeadingId} className="flex flex-col gap-1.5">
          <h3 id={evidenceHeadingId} className="text-sm font-medium text-muted-foreground">
            Evidence
          </h3>
          <EvidenceText key={task.id} text={task.evidence_excerpt} />
        </section>
        <MachineValue task={task} visible={machineVisible} />
        <div className="flex flex-col gap-2">
          <div role="group" aria-label="Your verdict" className="flex flex-wrap gap-2">
            {ANSWER_VALUES.map((value) => {
              const Icon = ANSWER_ICONS[value];
              const key = SHORTCUT_KEYS[value];
              return (
                <Button
                  key={value}
                  type="button"
                  variant="outline"
                  disabled={!canLabel}
                  aria-keyshortcuts={key}
                  aria-describedby={
                    canLabel || readOnlyReason === undefined ? undefined : readOnlyId
                  }
                  onClick={() => onAnswer(value)}
                >
                  <Icon aria-hidden="true" data-icon="inline-start" />
                  {LABEL_VALUE_LABELS[value]}
                  <Kbd aria-hidden="true">{key}</Kbd>
                </Button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-keyshortcuts={SHORTCUT_KEYS.skip}
              onClick={onSkip}
            >
              <SkipForward aria-hidden="true" data-icon="inline-start" />
              Skip
              <Kbd aria-hidden="true">{SHORTCUT_KEYS.skip}</Kbd>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!canUndo}
              aria-keyshortcuts={SHORTCUT_KEYS.undo}
              onClick={onUndo}
            >
              <Undo2 aria-hidden="true" data-icon="inline-start" />
              Undo last label
              <Kbd aria-hidden="true">{SHORTCUT_KEYS.undo}</Kbd>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link
                href={stepHref(task)}
                prefetch={false}
                target="_blank"
                rel="noopener noreferrer"
                aria-keyshortcuts={SHORTCUT_KEYS.open}
              >
                <ExternalLink aria-hidden="true" data-icon="inline-start" />
                Open step <span className="sr-only">in a new tab</span>
                <Kbd aria-hidden="true">{SHORTCUT_KEYS.open}</Kbd>
              </Link>
            </Button>
          </div>
          {canLabel || readOnlyReason === undefined ? null : (
            <p id={readOnlyId} className="text-sm text-muted-foreground">
              {readOnlyReason}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
