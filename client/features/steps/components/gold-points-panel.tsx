"use client";

import { SearchCheck, SearchX } from "lucide-react";
import { useId } from "react";
import { StatusBadge } from "@/components/status/status-badge";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Step } from "@/lib/api/types";
import { countFound, highlightAnswer, matchGoldPoint } from "../gold-match";
import { JsonText } from "./json-text";
import { OracleResultSheet } from "./oracle-result-sheet";

export type GoldPointsPanelProps = {
  step: Pick<Step, "gold_points" | "answer">;
};

function AnswerWithMarks({ answer, values }: { answer: string; values: readonly string[] }) {
  const segments = highlightAnswer(answer, values);
  return (
    <figure
      data-slot="gold-answer"
      aria-label="Answer with the rendered gold values marked"
      className="flex flex-col gap-1.5 rounded-lg border bg-muted/30 p-3"
    >
      <figcaption className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Answer
      </figcaption>
      <p className="text-sm break-words whitespace-pre-wrap">
        {segments.map((segment, index) =>
          segment.matched ? (
            <mark
              key={index}
              data-slot="gold-mark"
              className="rounded-sm bg-primary/15 px-0.5 text-foreground underline decoration-dotted underline-offset-2"
            >
              {segment.text}
            </mark>
          ) : (
            <span key={index}>{segment.text}</span>
          ),
        )}
      </p>
    </figure>
  );
}

function InAnswer({ rendered, answer }: { rendered: string; answer: string | null }) {
  const match = matchGoldPoint(rendered, answer);
  if (match === null) {
    return <span className="text-sm text-muted-foreground">No answer text</span>;
  }
  if (match.found) {
    return (
      <StatusBadge
        tone="hollow"
        icon={SearchCheck}
        label={match.occurrences > 1 ? `Found, ${match.occurrences} times` : "Found"}
        data-found="true"
      />
    );
  }
  return <StatusBadge tone="hollow" icon={SearchX} label="Not found" data-found="false" />;
}

export function GoldPointsPanel({ step }: GoldPointsPanelProps) {
  const headingId = useId();
  const points = step.gold_points;
  if (points.length === 0) {
    return null;
  }
  const rendered = points.map((point) => point.rendered);
  const found = countFound(rendered, step.answer);
  return (
    <section
      aria-labelledby={headingId}
      data-slot="gold-points-panel"
      className="flex min-w-0 flex-col gap-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="text-sm font-semibold">
          Gold points
        </h3>
        <Badge variant="outline">Not a verdict</Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        Values the oracle computed from the truth database. The marks only compare the rendered
        value with the answer text and are not a verdict.
        {found === null
          ? " This step has no answer text to compare."
          : ` ${found} of ${points.length} rendered ${points.length === 1 ? "value appears" : "values appear"} in the answer.`}
      </p>
      <div className="overflow-x-auto rounded-xl border">
        <Table aria-label="Gold points">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Key</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>Rendered</TableHead>
              <TableHead>In the answer</TableHead>
              <TableHead>Oracle result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {points.map((point, index) => (
              <TableRow key={`${point.key}-${index}`} data-slot="gold-point" data-key={point.key}>
                <TableCell className="font-mono text-xs break-all">{point.key}</TableCell>
                <TableCell className="min-w-24 whitespace-normal">
                  <JsonText value={point.value} label={`value of ${point.key}`} />
                </TableCell>
                <TableCell className="font-mono text-xs break-words whitespace-pre-wrap">
                  {point.rendered}
                </TableCell>
                <TableCell>
                  <InAnswer rendered={point.rendered} answer={step.answer} />
                </TableCell>
                <TableCell>
                  <OracleResultSheet
                    resultId={point.oracle_result_id}
                    subject={`gold point ${point.key}`}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {step.answer === null ? null : <AnswerWithMarks answer={step.answer} values={rendered} />}
    </section>
  );
}
