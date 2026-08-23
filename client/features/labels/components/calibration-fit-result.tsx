"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  CircleCheck,
  CircleX,
  Hourglass,
  LoaderCircle,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { DateTime } from "@/components/date-time";
import { PermissionDenied } from "@/components/permission-denied";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { StatusBadge } from "@/components/status/status-badge";
import type { Tone } from "@/components/status/tones";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCount } from "@/features/runs/results-format";
import { settingsQuery } from "@/features/settings/queries";
import { describeApiError, isApiError } from "@/lib/api/errors";
import type { CalibrationFit, CalibrationHeldOut, CalibrationThresholds } from "@/lib/api/types";
import { runRoutes } from "@/lib/routes";
import type { CalibrationFitQueryResult } from "../fit-queries";
import {
  describeFailedFit,
  describeKappaChange,
  fitPhase,
  formatThreshold,
  sortedTemperatures,
  THRESHOLD_ROWS,
  thresholdsMatch,
  type FitPhase,
  type ThresholdsInForce,
} from "../fit-model";
import { ApplyThresholdsDialog } from "./apply-thresholds-dialog";
import { formatKappaCell } from "./calibration-table";

type SettledPhase = Exclude<FitPhase, "running" | "failed">;

type PhasePresentation = {
  tone: Tone;
  icon: LucideIcon;
  label: string;
  text: string;
};

const PHASE_PRESENTATION: Readonly<Record<SettledPhase, PhasePresentation>> = {
  adopted: {
    tone: "kpi-good",
    icon: CircleCheck,
    label: "Adopted",
    text:
      "Kappa improved on the held-out labels, so the server adopted these thresholds. " +
      "They are in force now.",
  },
  applied: {
    tone: "kpi-good",
    icon: CircleCheck,
    label: "Applied by an admin",
    text:
      "These thresholds are in force now. " +
      "The server had kept the previous ones because kappa did not improve.",
  },
  proposal: {
    tone: "kpi-warn",
    icon: TriangleAlert,
    label: "Proposal only",
    text:
      "Kappa did not improve on the held-out labels, so the server kept the current thresholds. " +
      "An admin can still apply the proposal.",
  },
  no_proposal: {
    tone: "hollow",
    icon: Hourglass,
    label: "No proposal",
    text:
      "The fit finished without thresholds. Too few held-out labels had a decided grade, " +
      "so there is nothing to adopt or apply. Label more and fit again.",
  },
};

export type CalibrationFitResultProps = {
  runId: string;
  fit: CalibrationFitQueryResult;
  showRunLink?: boolean;
};

function FitLoading() {
  return (
    <div role="status" aria-busy="true" data-slot="fit-loading" className="flex flex-col gap-2">
      <span className="sr-only">Loading the calibration fit</span>
      <Skeleton className="h-6 w-56" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

function FitError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (isApiError(error) && error.status === 403) {
    return <PermissionDenied variant="inline" action="calibration.fit" />;
  }
  return (
    <ErrorState
      title="Could not load the calibration fit"
      description={describeApiError(error)}
      requestId={readRequestId(error)}
      onRetry={onRetry}
      className="py-8"
    />
  );
}

function RunningFit({ status }: { status: CalibrationFit["status"] }) {
  return (
    <div
      role="status"
      data-slot="fit-running"
      className="flex items-center gap-2 rounded-lg border p-3 text-sm"
    >
      <LoaderCircle
        aria-hidden="true"
        className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
      />
      <span>
        {status === "queued" ? "The fit is queued." : "The fit is running."} It fits on most labels,
        then checks kappa on labels it held out. This page updates by itself.
      </span>
    </div>
  );
}

function FailedFit({ fit, showRunLink }: { fit: CalibrationFit; showRunLink: boolean }) {
  const copy = describeFailedFit(fit.status);
  return (
    <Alert variant="destructive" data-slot="fit-failed">
      <CircleX aria-hidden="true" />
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>
        {copy.description}
        {showRunLink ? (
          <>
            {" "}
            <Link href={runRoutes.detail(fit.run_id)}>Open the run</Link>
          </>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function PhaseBanner({ phase }: { phase: SettledPhase }) {
  const presentation = PHASE_PRESENTATION[phase];
  return (
    <div data-slot="fit-verdict" data-phase={phase} className="flex flex-col items-start gap-2">
      <StatusBadge tone={presentation.tone} icon={presentation.icon} label={presentation.label} />
      <p className="max-w-3xl text-sm">{presentation.text}</p>
    </div>
  );
}

function HeldOutSummary({ heldOut }: { heldOut: CalibrationHeldOut }) {
  return (
    <section data-slot="fit-held-out" className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Held-out check</h3>
      <dl className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">Held-out labels</dt>
          <dd data-slot="fit-n-labels" className="text-lg font-semibold tabular-nums">
            {formatCount(heldOut.n_labels)}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">Kappa before</dt>
          <dd data-slot="fit-kappa-before" className="text-lg font-semibold tabular-nums">
            {formatKappaCell(heldOut.kappa_before)}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">Kappa after</dt>
          <dd data-slot="fit-kappa-after" className="text-lg font-semibold tabular-nums">
            {formatKappaCell(heldOut.kappa_after)}
          </dd>
        </div>
      </dl>
      <p className="text-sm text-muted-foreground">{describeKappaChange(heldOut)}</p>
    </section>
  );
}

type ThresholdTableProps = {
  proposed: CalibrationThresholds;
  current: ThresholdsInForce | undefined;
  currentFailed: boolean;
};

function currentCell(
  current: ThresholdsInForce | undefined,
  currentFailed: boolean,
  key: keyof CalibrationThresholds,
): string {
  if (current !== undefined) {
    return formatThreshold(current[key]);
  }
  return currentFailed ? "Unavailable" : "Loading";
}

function ThresholdTable({ proposed, current, currentFailed }: ThresholdTableProps) {
  return (
    <section data-slot="fit-thresholds" className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Thresholds</h3>
      <Table>
        <TableCaption className="sr-only">
          Thresholds in force now beside the thresholds the fit proposes
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Threshold</TableHead>
            <TableHead className="text-end">In force now</TableHead>
            <TableHead className="text-end">Proposed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {THRESHOLD_ROWS.map((row) => {
            const changed = current !== undefined && current[row.key] !== proposed[row.key];
            return (
              <TableRow key={row.key} data-threshold={row.key} data-changed={changed}>
                <TableCell>{row.label}</TableCell>
                <TableCell className="text-end font-mono tabular-nums">
                  {currentCell(current, currentFailed, row.key)}
                </TableCell>
                <TableCell className="text-end font-mono tabular-nums">
                  {formatThreshold(proposed[row.key])}
                  {changed ? <span className="font-sans text-xs"> (changed)</span> : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

function Temperatures({ temperatures }: { temperatures: CalibrationFit["temperatures"] }) {
  const entries = sortedTemperatures(temperatures);
  if (entries.length === 0) {
    return null;
  }
  return (
    <Collapsible data-slot="fit-temperatures" className="flex flex-col gap-2">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="w-fit">
          Probe temperatures ({entries.length})
          <ChevronDown aria-hidden="true" data-icon="inline-end" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul aria-label="Fitted probe temperatures" className="flex flex-col gap-1 text-sm">
          {entries.map(([probeId, temperature]) => (
            <li key={probeId} className="flex flex-wrap justify-between gap-2">
              <span className="font-mono text-xs wrap-anywhere">{probeId}</span>
              <span className="font-mono tabular-nums">{temperature.toFixed(2)}</span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function FitFooter({ fit, showRunLink }: { fit: CalibrationFit; showRunLink: boolean }) {
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span>
        Started <DateTime value={fit.created_at} />
      </span>
      {fit.probe_bank_version === null ? null : <span>Probe bank {fit.probe_bank_version}</span>}
      {showRunLink ? (
        <Link
          href={runRoutes.detail(fit.run_id)}
          className="font-medium underline-offset-4 hover:underline"
        >
          Open the run
        </Link>
      ) : null}
    </p>
  );
}

export function CalibrationFitResult({
  runId,
  fit,
  showRunLink = true,
}: CalibrationFitResultProps) {
  const settings = useQuery(settingsQuery());
  if (fit.isPending) {
    return <FitLoading />;
  }
  if (fit.isError) {
    return <FitError error={fit.error} onRetry={() => void fit.refetch()} />;
  }
  const result = fit.data;
  const current = settings.data?.thresholds;
  const inForce = result.thresholds !== null && thresholdsMatch(current, result.thresholds);
  const phase = fitPhase(result, inForce);

  return (
    <div
      data-slot="calibration-fit-result"
      data-phase={phase}
      data-run-id={runId}
      className="flex flex-col gap-4"
    >
      {phase === "running" ? <RunningFit status={result.status} /> : null}
      {phase === "failed" ? <FailedFit fit={result} showRunLink={showRunLink} /> : null}
      {phase === "running" || phase === "failed" ? null : (
        <>
          <PhaseBanner phase={phase} />
          {result.held_out === null ? null : <HeldOutSummary heldOut={result.held_out} />}
          {result.thresholds === null ? null : (
            <ThresholdTable
              proposed={result.thresholds}
              current={current}
              currentFailed={settings.isError}
            />
          )}
          {phase === "proposal" && result.thresholds !== null ? (
            <div className="flex flex-wrap items-center gap-3">
              <ApplyThresholdsDialog
                proposed={result.thresholds}
                current={current}
                heldOut={result.held_out}
              />
              {settings.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  The thresholds in force could not be loaded, so they cannot be applied yet.{" "}
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    onClick={() => void settings.refetch()}
                  >
                    Try again
                  </Button>
                </p>
              ) : null}
            </div>
          ) : null}
          <Temperatures temperatures={result.temperatures} />
        </>
      )}
      <FitFooter fit={result} showRunLink={showRunLink && phase !== "failed"} />
    </div>
  );
}
