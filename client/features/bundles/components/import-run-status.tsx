"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { CircleCheck, CircleX, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { DateTime } from "@/components/date-time";
import { RunStatusBadge } from "@/components/status/run-status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { RunSummary } from "@/lib/api/types";
import { runRoutes } from "@/lib/routes";
import { useHydrated } from "@/lib/use-hydrated";
import {
  importRunRefetchInterval,
  isActiveImportStatus,
  latestImportRunQuery,
} from "../bundle-source-queries";

function RunLink({ run, label }: { run: RunSummary; label: string }) {
  return (
    <Link href={runRoutes.detail(run.id)} className="font-medium underline underline-offset-4">
      {label}
    </Link>
  );
}

function describeFinished(run: RunSummary): string {
  if (run.status === "completed") {
    return "The last pull finished";
  }
  if (run.status === "failed") {
    return "The last pull failed";
  }
  return "The last pull was stopped";
}

export type ImportRunStatusProps = {
  targetId: string;
};

export function ImportRunStatus({ targetId }: ImportRunStatusProps) {
  const hydrated = useHydrated();
  const query = useInfiniteQuery({
    ...latestImportRunQuery(targetId),
    refetchInterval: importRunRefetchInterval,
  });
  const latest = hydrated ? query.data?.items[0] : undefined;

  if (latest === undefined) {
    return null;
  }

  if (isActiveImportStatus(latest.status)) {
    return (
      <Alert role="status" data-slot="import-run-status" data-state="running">
        <LoaderCircle aria-hidden="true" className="animate-spin" />
        <AlertTitle className="flex flex-wrap items-center gap-2">
          A pull is running <RunStatusBadge status={latest.status} />
        </AlertTitle>
        <AlertDescription>
          Started <DateTime value={latest.created_at} />.{" "}
          <RunLink run={latest} label="Open the run" /> to follow it.
        </AlertDescription>
      </Alert>
    );
  }

  const failed = latest.status === "failed";
  return (
    <Alert
      role="status"
      variant={failed ? "destructive" : "default"}
      data-slot="import-run-status"
      data-state={failed ? "failed" : "finished"}
    >
      {failed ? <CircleX aria-hidden="true" /> : <CircleCheck aria-hidden="true" />}
      <AlertTitle className="flex flex-wrap items-center gap-2">
        {describeFinished(latest)} <RunStatusBadge status={latest.status} />
      </AlertTitle>
      <AlertDescription>
        <DateTime value={latest.finished_at ?? latest.created_at} />.{" "}
        <RunLink run={latest} label="Open the run" />
        {failed ? " to read the reason Git reported." : "."}
      </AlertDescription>
    </Alert>
  );
}
