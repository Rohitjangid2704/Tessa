"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { CodeView } from "@/components/code-view";
import { DateTime } from "@/components/date-time";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Skeleton } from "@/components/ui/skeleton";
import { ArtifactVideo } from "@/features/steps/components/artifact-video";
import {
  EmptyNote,
  FactList,
  StepSection,
  type Fact,
} from "@/features/steps/components/step-section";
import { TruncatedText } from "@/features/steps/components/text-view";
import { useArtifactRefresh } from "@/features/steps/use-artifact-refresh";
import { describeApiError } from "@/lib/api/errors";
import type { FindingRepro, ReproSeed } from "@/lib/api/types";
import { runRoutes } from "@/lib/routes";
import { findingReproQuery, isFindingNotFound } from "../detail-queries";
import { shortId } from "../detail-schemas";
import { ValueView } from "./value-view";

export const ORACLE_COLUMN_LIMIT = 8;
export const ORACLE_CELL_LIMIT = 160;

export interface ReproPanelProps {
  findingId: string;
}

export function describeSeed(seed: ReproSeed): string {
  if (seed.version === null && seed.hash === null) {
    return "No seed was recorded for this run";
  }
  const version = seed.version === null ? "unknown version" : `version ${seed.version}`;
  return seed.hash === null ? `Seed ${version}` : `Seed ${version}, hash ${seed.hash}`;
}

export function oracleColumns(rows: readonly Record<string, unknown>[]): string[] {
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key) && columns.length < ORACLE_COLUMN_LIMIT) {
        columns.push(key);
      }
    }
  }
  return columns;
}

export function formatOracleCell(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function OracleRowsTable({ rows }: { rows: readonly Record<string, unknown>[] }) {
  const columns = oracleColumns(rows);
  if (rows.length === 0) {
    return <EmptyNote>No oracle rows were recorded for this finding.</EmptyNote>;
  }
  return (
    <div
      role="region"
      aria-label="Oracle rows"
      tabIndex={0}
      className="max-h-80 overflow-auto rounded-md border"
    >
      <table data-slot="oracle-rows" className="w-full text-left text-xs">
        <caption className="sr-only">
          Oracle rows compared with the answer, at most 20, shown as text
        </caption>
        <thead className="bg-muted/50">
          <tr>
            <th scope="col" className="px-2 py-1.5 font-medium text-muted-foreground">
              #
            </th>
            {columns.map((column) => (
              <th
                key={column}
                scope="col"
                className="px-2 py-1.5 font-mono font-medium text-muted-foreground"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-t align-top">
              <th scope="row" className="px-2 py-1.5 font-normal text-muted-foreground">
                {index + 1}
              </th>
              {columns.map((column) => (
                <td key={column} className="px-2 py-1.5 font-mono wrap-anywhere">
                  <TruncatedText text={formatOracleCell(row[column])} limit={ORACLE_CELL_LIMIT} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TranscriptList({ repro }: { repro: FindingRepro }) {
  if (repro.transcript.length === 0) {
    return <EmptyNote>No transcript was recorded for this attempt.</EmptyNote>;
  }
  return (
    <ol data-slot="repro-transcript" aria-label="Transcript of the failing attempt" className="flex flex-col gap-2">
      {repro.transcript.map((row) => (
        <li key={row.step_id} className="flex flex-col gap-1 rounded-lg border bg-card px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium wrap-anywhere">
              Step {row.index + 1}: {row.label}
            </span>
            <Link
              href={runRoutes.step(repro.run_id, row.step_id)}
              className="text-xs text-primary underline underline-offset-4"
            >
              Open step {shortId(row.step_id)}
            </Link>
          </div>
          {row.ask === null ? null : (
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">Asked: </span>
              <TruncatedText text={row.ask} />
            </p>
          )}
          {row.answer === null ? null : (
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">Answered: </span>
              <TruncatedText text={row.answer} />
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

function reproFacts(repro: FindingRepro): Fact[] {
  return [
    {
      label: "Run",
      value: (
        <Link
          href={runRoutes.detail(repro.run_id)}
          className="text-primary underline underline-offset-4"
        >
          Run {shortId(repro.run_id)}
        </Link>
      ),
    },
    { label: "Attempt", value: String(repro.attempt + 1) },
    { label: "Bundle version", value: String(repro.bundle_version) },
    { label: "Scenario version", value: String(repro.scenario_version) },
    { label: "Seed", value: describeSeed(repro.seed), mono: repro.seed.hash !== null },
    {
      label: "Clock",
      value: (
        <span>
          {repro.clock.mode === "pinned" ? "Pinned to " : "Real clock, read at "}
          <DateTime value={repro.clock.at} />
        </span>
      ),
    },
    {
      label: "Browser session",
      value: repro.browser_session_id === null ? "None, this was an API run" : repro.browser_session_id,
      mono: repro.browser_session_id !== null,
    },
  ];
}

export function ReproPanel({ findingId }: ReproPanelProps) {
  const query = useQuery(findingReproQuery(findingId));
  const repro = query.data;
  const refresh = useArtifactRefresh(repro?.screencast ?? [], query.refetch);

  if (query.isPending) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-4">
        <span className="sr-only">Loading the repro</span>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (repro === undefined) {
    return (
      <ErrorState
        title={isFindingNotFound(query.error) ? "No repro for this finding" : "Could not load the repro"}
        description={
          isFindingNotFound(query.error)
            ? "The repro of this finding is not available."
            : describeApiError(query.error)
        }
        requestId={readRequestId(query.error)}
        onRetry={() => void query.refetch()}
        className="py-8"
      />
    );
  }

  return (
    <div data-slot="repro-panel" className="flex flex-col gap-6">
      <StepSection title="Where it happened">
        <FactList facts={reproFacts(repro)} />
      </StepSection>
      <StepSection title="Scenario">
        <CodeView value={repro.scenario_yaml} language="yaml" label="Scenario YAML of the repro" />
      </StepSection>
      <StepSection title="Expected and actual">
        <div className="grid gap-3 md:grid-cols-2">
          <ValueView value={repro.expected} label="Expected" />
          <ValueView value={repro.actual} label="Actual" />
        </div>
      </StepSection>
      <StepSection title="Oracle rows">
        <OracleRowsTable rows={repro.oracle_rows} />
      </StepSection>
      <StepSection title="Transcript">
        <TranscriptList repro={repro} />
      </StepSection>
      <StepSection title="Screencast">
        {repro.screencast.length === 0 ? (
          <EmptyNote>No recording was captured for this attempt.</EmptyNote>
        ) : (
          <div className="grid gap-3">
            {repro.screencast.map((artifact, index) => (
              <ArtifactVideo
                key={artifact.id}
                artifact={artifact}
                label={`Screencast ${index + 1} of ${repro.screencast.length} for the failing attempt`}
                refreshing={refresh.refreshing}
                expired={refresh.isExpired(artifact)}
                onLoadError={refresh.reportLoadError}
                onReload={refresh.reload}
              />
            ))}
          </div>
        )}
      </StepSection>
    </div>
  );
}
