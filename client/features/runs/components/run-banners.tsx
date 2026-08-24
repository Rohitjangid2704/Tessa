"use client";

import { Hourglass, RefreshCw, Wallet, WifiOff } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatUsd } from "@/lib/format-usd";
import { useNow } from "@/lib/use-now";
import { describeConnection } from "../connection";
import type { RunEventsSnapshot } from "../run-event-store";
import { useRunEvents, useRunStreamState } from "../use-run-stream";

const MS_PER_SECOND = 1000;

function secondsUntil(nextRetryAt: number | null, now: number | null): number | null {
  if (nextRetryAt === null || now === null) {
    return null;
  }
  return Math.max(0, Math.ceil((nextRetryAt - now) / MS_PER_SECOND));
}

function ReconnectingBanner() {
  const { attempt, message, nextRetryAt } = useRunStreamState();
  const now = useNow(MS_PER_SECOND);
  const seconds = secondsUntil(nextRetryAt, now);
  return (
    <Alert role="group" aria-label="Connection" data-slot="reconnecting-banner">
      <WifiOff aria-hidden="true" />
      <AlertTitle>Reconnecting to the live stream</AlertTitle>
      <AlertDescription>
        {message ?? "The connection was lost."} Attempt {attempt}
        {seconds === null ? "" : `, retrying in ${seconds} s`}. Counters and events pick up where
        they stopped.
      </AlertDescription>
    </Alert>
  );
}

function ResyncingBanner() {
  return (
    <Alert role="group" aria-label="Connection" data-slot="resyncing-banner">
      <RefreshCw aria-hidden="true" />
      <AlertTitle>Reloading missed events</AlertTitle>
      <AlertDescription>
        The server could not replay everything this page missed, so the latest events are being
        loaded again before the stream resumes.
      </AlertDescription>
    </Alert>
  );
}

function FailedBanner() {
  const { message, restart } = useRunStreamState();
  return (
    <Alert variant="destructive" data-slot="stream-failed-banner">
      <WifiOff aria-hidden="true" />
      <AlertTitle>Live updates stopped</AlertTitle>
      <AlertDescription>
        <p>{message ?? "The live stream failed."} The numbers below are the last ones received.</p>
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={restart}>
          <RefreshCw aria-hidden="true" data-icon="inline-start" />
          Reload this run
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function findLastExhausted(snapshot: RunEventsSnapshot) {
  return snapshot.events.findLast((event) => event.type === "budget.exhausted");
}

function describeExhaustion(snapshot: RunEventsSnapshot): string {
  const exhausted = findLastExhausted(snapshot);
  if (exhausted?.type !== "budget.exhausted") {
    return "The run stopped when it reached its budget. Scenarios that had not started were skipped.";
  }
  const { dimension, limit, actual } = exhausted.payload;
  return dimension === "usd"
    ? `The run stopped at its cost limit of ${formatUsd(limit)} (reached ${formatUsd(actual)}). Scenarios that had not started were skipped.`
    : `The run stopped at its time limit of ${limit} min (reached ${actual} min). Scenarios that had not started were skipped.`;
}

function BudgetExceededBanner() {
  const snapshot = useRunEvents();
  return (
    <Alert role="group" aria-label="Budget" data-slot="budget-exceeded-banner">
      <Wallet aria-hidden="true" />
      <AlertTitle>Budget exceeded</AlertTitle>
      <AlertDescription>{describeExhaustion(snapshot)}</AlertDescription>
    </Alert>
  );
}

function CancelingBanner() {
  return (
    <Alert role="group" aria-label="Cancellation" data-slot="canceling-banner">
      <Hourglass aria-hidden="true" />
      <AlertTitle>Cancel requested</AlertTitle>
      <AlertDescription>
        Waiting for the workflow to stop. Work already in flight finishes its current step.
      </AlertDescription>
    </Alert>
  );
}

export function RunBanners() {
  const { run, status, isTerminal } = useRunStreamState();
  const connection = describeConnection({ status, isTerminal });
  return (
    <>
      {connection.banner === "reconnecting" ? <ReconnectingBanner /> : null}
      {connection.banner === "resyncing" ? <ResyncingBanner /> : null}
      {connection.banner === "failed" ? <FailedBanner /> : null}
      {run?.status === "canceling" ? <CancelingBanner /> : null}
      {run?.status === "budget_exceeded" ? <BudgetExceededBanner /> : null}
    </>
  );
}
