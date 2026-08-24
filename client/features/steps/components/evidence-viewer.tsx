"use client";

import { ChevronDown, Minus, ScanText } from "lucide-react";
import { useId, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { EvidenceGoldPoint, Step } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { appearsIn, dedupeNeedles, type MarkKind, type Needle } from "../evidence-marking";
import { ExpandableText, MARK_CLASSES, MARK_SPOKEN } from "./expandable-text";
import { StepSection } from "./step-section";

interface GoldItem {
  key: string;
  rendered: string;
  judgeRelied: boolean;
}

interface ClaimItem {
  text: string;
  note: string | null;
}

interface ClaimSource {
  texts: readonly string[];
  note: string | null;
}

function collectGold(
  sent: readonly EvidenceGoldPoint[],
  relied: readonly EvidenceGoldPoint[],
): GoldItem[] {
  const reliedKeys = new Set(relied.map((point) => point.key));
  const merged = new Map<string, EvidenceGoldPoint>();
  for (const point of [...sent, ...relied]) {
    if (!merged.has(point.key)) {
      merged.set(point.key, point);
    }
  }
  return [...merged.values()].map((point) => ({
    key: point.key,
    rendered: point.rendered,
    judgeRelied: reliedKeys.has(point.key),
  }));
}

function collectClaims(sources: readonly ClaimSource[]): ClaimItem[] {
  const notesByText = new Map<string, string[]>();
  for (const source of sources) {
    for (const text of source.texts) {
      const notes = notesByText.get(text) ?? [];
      if (source.note !== null) {
        notes.push(source.note);
      }
      notesByText.set(text, notes);
    }
  }
  return [...notesByText].map(([text, notes]) => ({
    text,
    note: notes.length === 0 ? null : notes.join(", "),
  }));
}

function MarkSample({ kind }: { kind: MarkKind }) {
  return (
    <span className={cn("rounded-sm px-1", MARK_CLASSES[kind])} data-kind={kind}>
      {MARK_SPOKEN[kind]}
    </span>
  );
}

function PresenceTag({ present }: { present: boolean }) {
  const Icon = present ? ScanText : Minus;
  return (
    <span
      data-slot="presence-tag"
      data-present={present}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground"
    >
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      {present ? "Appears in the answer" : "Not found in the answer"}
    </span>
  );
}

interface EvidenceListProps {
  title: string;
  kind: MarkKind;
  empty: string;
  count: number;
  children: ReactNode;
}

function EvidenceList({ title, kind, empty, count, children }: EvidenceListProps) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-slot="evidence-list"
      data-kind={kind}
      className="flex flex-col gap-1.5"
    >
      <h4 id={headingId} className="flex items-center gap-2 text-sm font-medium">
        {title}
        <span className="text-xs font-normal text-muted-foreground tabular-nums">{count}</span>
      </h4>
      {count === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">{children}</ul>
      )}
    </section>
  );
}

const ITEM_CLASSES = "flex flex-col gap-0.5 rounded-lg border px-3 py-2 text-sm";
const ITEM_META_CLASSES = "flex flex-wrap items-center gap-x-3 gap-y-0.5";

interface ClaimRowsProps {
  slot: string;
  items: readonly ClaimItem[];
  presentIn: (text: string) => boolean;
}

function ClaimRows({ slot, items, presentIn }: ClaimRowsProps) {
  return items.map((item) => (
    <li
      key={item.text}
      data-slot={slot}
      data-in-answer={presentIn(item.text)}
      className={ITEM_CLASSES}
    >
      <span className="wrap-anywhere">{item.text}</span>
      <span className={ITEM_META_CLASSES}>
        <PresenceTag present={presentIn(item.text)} />
        {item.note === null ? null : (
          <span className="text-xs text-muted-foreground">{item.note}</span>
        )}
      </span>
    </li>
  ));
}

const MARK_KINDS = ["gold", "forbidden", "unsupported"] as const satisfies readonly MarkKind[];

function EvidenceBody({ step }: { step: Step }) {
  const evidence = step.evidence;
  const judgeEvidence = step.judge?.evidence ?? null;
  const answer = evidence?.answer ?? step.answer;
  const ask = evidence?.ask ?? step.ask;

  const gold = collectGold(evidence?.gold_points ?? [], judgeEvidence?.gold_points ?? []);
  const forbidden = collectClaims([
    { texts: evidence?.must_not_claim ?? [], note: null },
    { texts: judgeEvidence?.must_not_claim ?? [], note: "found by the judge" },
  ]);
  const unsupported = collectClaims([
    { texts: evidence?.unsupported_claim_candidates ?? [], note: "candidate" },
    { texts: judgeEvidence?.unsupported_claims ?? [], note: "found by the judge" },
  ]);

  const needles = dedupeNeedles([
    ...gold.map((item): Needle => ({ text: item.rendered, kind: "gold" })),
    ...forbidden.map((item): Needle => ({ text: item.text, kind: "forbidden" })),
    ...unsupported.map((item): Needle => ({ text: item.text, kind: "unsupported" })),
  ]);
  const presentIn = (text: string): boolean => answer !== null && appearsIn(answer, text);
  const kinds = MARK_KINDS.filter((kind) => needles.some((needle) => needle.kind === kind));

  return (
    <StepSection title="Evidence">
      <div data-slot="evidence-viewer" className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          What the judge was given and what it found. Highlighting is plain text matching for
          reading only. It is not a verdict.
        </p>

        {ask === null ? null : (
          <div data-slot="evidence-ask" className="flex flex-col gap-1">
            <h4 className="text-sm font-medium">Asked</h4>
            <ExpandableText text={ask} />
          </div>
        )}

        <div data-slot="evidence-answer" className="flex flex-col gap-1">
          <h4 className="text-sm font-medium">Answer under test</h4>
          {answer === null ? (
            <p className="text-sm text-muted-foreground">This step has no answer text.</p>
          ) : (
            <ExpandableText text={answer} needles={needles} />
          )}
          {kinds.length === 0 ? null : (
            <p
              data-slot="mark-legend"
              className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
            >
              Marked in the answer:
              {kinds.map((kind) => (
                <MarkSample key={kind} kind={kind} />
              ))}
            </p>
          )}
        </div>

        <EvidenceList
          title="Gold points"
          kind="gold"
          count={gold.length}
          empty="No gold points were sent for this step."
        >
          {gold.map((item) => (
            <li
              key={item.key}
              data-slot="gold-item"
              data-in-answer={presentIn(item.rendered)}
              className={ITEM_CLASSES}
            >
              <span>
                <span className="font-mono text-xs text-muted-foreground">{item.key}</span>{" "}
                <span className="wrap-anywhere">{item.rendered}</span>
              </span>
              <span className={ITEM_META_CLASSES}>
                <PresenceTag present={presentIn(item.rendered)} />
                {item.judgeRelied ? (
                  <span className="text-xs text-muted-foreground">The judge relied on it</span>
                ) : null}
              </span>
            </li>
          ))}
        </EvidenceList>

        <EvidenceList
          title="Must not claim"
          kind="forbidden"
          count={forbidden.length}
          empty="No forbidden claims were sent for this step."
        >
          <ClaimRows slot="forbidden-item" items={forbidden} presentIn={presentIn} />
        </EvidenceList>

        <EvidenceList
          title="Unsupported claims"
          kind="unsupported"
          count={unsupported.length}
          empty="No unsupported claims were found."
        >
          <ClaimRows slot="unsupported-item" items={unsupported} presentIn={presentIn} />
        </EvidenceList>

        {evidence === null ? null : (
          <Collapsible data-slot="evidence-rubric">
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="group">
                Rubric and invariants given to the judge
                <ChevronDown
                  aria-hidden="true"
                  data-icon="inline-end"
                  className="transition-transform group-aria-expanded:rotate-180"
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-2 pt-2">
              <h4 className="text-sm font-medium">Rubric</h4>
              <ExpandableText text={evidence.rubric} />
              {evidence.invariants.length === 0 ? null : (
                <ul aria-label="Invariants" className="flex flex-col gap-1 text-sm">
                  {evidence.invariants.map((invariant) => (
                    <li key={invariant.id}>
                      <span className="font-mono text-xs">{invariant.id}</span>{" "}
                      <span className="text-muted-foreground wrap-anywhere">{invariant.rule}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </StepSection>
  );
}

export function EvidenceViewer({ step }: { step: Step }) {
  if (step.evidence === null && step.judge === null) {
    return null;
  }
  return <EvidenceBody step={step} />;
}
