"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { ContractVerdictBadge } from "@/features/contracts/components/contract-verdict-badge";
import { ProgressBlock } from "@/features/contracts/components/progress-block";
import {
  describeCheckOutcome,
  latestContractProgress,
  progressFromCheck,
  progressFromPayload,
} from "@/features/contracts/model";
import { contractCheckForRunQuery, contractCheckQuery } from "@/features/contracts/queries";
import { describeApiError } from "@/lib/api/errors";
import type { ContractCheck } from "@/lib/api/types";
import { contractRoutes } from "@/lib/routes";
import { EventLog } from "../components/event-log";
import { isTerminalRunStatus } from "../run-status";
import { useRunEvents, useRunStreamState } from "../use-run-stream";

export type ContractViewProps = { runId: string };

function CheckResult({ check }: { check: ContractCheck }) {
  const outcome = describeCheckOutcome(check);
  if (outcome === "breaking") {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <ContractVerdictBadge verdict="fail" />
        <span data-slot="breaking-count">{check.breaking} breaking</span>
      </p>
    );
  }
  if (outcome === "undecided") {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <ContractVerdictBadge verdict="uncertain" />
        <span>Some items could not be decided. Open the diff to see which.</span>
      </p>
    );
  }
  if (outcome === "unfinished") {
    return (
      <p className="text-sm text-muted-foreground">
        The run ended as {check.status.replace("_", " ")} before every item was compared.
      </p>
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm">
      <ContractVerdictBadge verdict="pass" />
      <span>No item breaks the consumer.</span>
    </p>
  );
}

export function ContractView({ runId }: ContractViewProps) {
  const headingId = useId();
  const { run } = useRunStreamState();
  const { events } = useRunEvents();
  const progressPayload = latestContractProgress(events);
  const lookup = useQuery(contractCheckForRunQuery(runId));
  const checkId = progressPayload?.contract_check_id ?? lookup.data?.id ?? null;
  const check = useQuery({ ...contractCheckQuery(checkId ?? ""), enabled: checkId !== null });
  const terminal = run !== undefined && isTerminalRunStatus(run.status);
  const progress =
    progressPayload !== null
      ? progressFromPayload(progressPayload)
      : check.data !== undefined
        ? progressFromCheck(check.data)
        : null;

  return (
    <div data-slot="contract-view" data-run-id={runId} className="flex flex-col gap-8">
      <section
        aria-labelledby={headingId}
        className="flex flex-col gap-4 rounded-xl border bg-card p-4"
      >
        <h2 id={headingId} className="text-base font-semibold">
          Contract check
        </h2>
        {terminal ? null : progress === null ? (
          <p className="text-sm text-muted-foreground">
            Waiting for the first item to be compared.
          </p>
        ) : (
          <ProgressBlock progress={progress} />
        )}
        {terminal && check.data !== undefined ? <CheckResult check={check.data} /> : null}
        {terminal && check.data === undefined && check.isPending && checkId !== null ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading the result
          </p>
        ) : null}
        {terminal && checkId === null && !lookup.isPending ? (
          <p className="text-sm text-muted-foreground">
            This run ended before a contract check was recorded for it.
          </p>
        ) : null}
        {check.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
            <span>Could not load the check result. {describeApiError(check.error)}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void check.refetch()}>
              Try again
            </Button>
          </div>
        ) : null}
        {checkId === null ? null : (
          <div>
            <Button asChild>
              <Link href={contractRoutes.detail(checkId)}>Open the diff</Link>
            </Button>
          </div>
        )}
      </section>
      <EventLog runId={runId} />
    </div>
  );
}
