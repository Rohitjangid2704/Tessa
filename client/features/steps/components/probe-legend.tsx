"use client";

import { ChevronDown } from "lucide-react";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { useProbeBank } from "@/features/probes/queries";
import { describeApiError } from "@/lib/api/errors";
import type { Probe, ProbeResult, ProbeStatus } from "@/lib/api/types";
import { ANSWER_TYPE_LABELS, formatUnit, PACK_LABELS, PROBE_STATUS_MEANINGS } from "../probe-model";
import { ProbeStatusChip } from "./probe-status-chip";

const STATUS_ORDER: readonly ProbeStatus[] = ["decided", "uncertain", "error"];

interface BankRow {
  result: ProbeResult;
  probe: Probe | undefined;
}

function describeBankChange(row: BankRow): string {
  if (row.probe === undefined) {
    return "Not in the current bank";
  }
  if (row.probe.version !== row.result.probe_bank_version) {
    return `Bank is now ${row.probe.version}, graded with ${row.result.probe_bank_version}`;
  }
  return "";
}

function BankTable({ results }: { results: readonly ProbeResult[] }) {
  const bank = useProbeBank();

  if (bank.isPending) {
    return (
      <div data-slot="probe-bank-loading" className="flex flex-col gap-1.5" aria-busy="true">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-4 w-full" />
        <span className="sr-only">Loading the probe bank</span>
      </div>
    );
  }

  if (bank.isError) {
    const requestId = readRequestId(bank.error);
    return (
      <div
        role="alert"
        data-slot="probe-bank-error"
        className="flex flex-wrap items-center gap-2 text-sm"
      >
        <span>
          Could not load the probe bank. {describeApiError(bank.error)}
          {requestId === null ? "" : ` (request ${requestId})`}
        </span>
        <Button type="button" variant="outline" size="xs" onClick={() => void bank.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const rows: BankRow[] = results.map((result) => ({
    result,
    probe: bank.byId.get(result.probe_id),
  }));

  return (
    <div className="overflow-x-auto">
      <table data-slot="probe-bank-table" className="w-full text-left text-xs">
        <caption className="pb-1 text-left font-medium text-muted-foreground">
          Probes used by this step, from the probe bank
        </caption>
        <thead>
          <tr className="text-muted-foreground">
            <th scope="col" className="py-1 pr-3 font-medium">
              Probe
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Pack
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Answer type
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Source
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Threshold now
            </th>
            <th scope="col" className="py-1 font-medium">
              Note
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.result.id} data-probe-id={row.result.probe_id} className="border-t">
              <th scope="row" className="py-1 pr-3 font-mono font-normal wrap-anywhere">
                {row.result.probe_id}
              </th>
              <td className="py-1 pr-3">{PACK_LABELS[row.result.pack]}</td>
              <td className="py-1 pr-3">
                {row.probe === undefined ? "Unknown" : ANSWER_TYPE_LABELS[row.probe.answer_type]}
              </td>
              <td className="py-1 pr-3">{row.probe?.source ?? "Unknown"}</td>
              <td className="py-1 pr-3 tabular-nums">
                {row.probe === undefined ? "n/a" : formatUnit(row.probe.threshold)}
              </td>
              <td className="py-1">{describeBankChange(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ProbeLegend({ results }: { results: readonly ProbeResult[] }) {
  return (
    <Collapsible data-slot="probe-legend" className="rounded-lg border">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="group w-full justify-between">
          How to read the probe results
          <ChevronDown
            aria-hidden="true"
            data-icon="inline-end"
            className="transition-transform group-aria-expanded:rotate-180"
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 border-t p-3">
        <ul aria-label="Probe statuses" className="flex flex-col gap-1.5 text-sm">
          {STATUS_ORDER.map((status) => (
            <li key={status} data-status={status} className="flex flex-wrap items-center gap-2">
              <ProbeStatusChip status={status} />
              <span className="text-muted-foreground">{PROBE_STATUS_MEANINGS[status]}</span>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">
          The bar shows the confidence from 0 to 1 and the vertical tick is the threshold. The
          colour follows the status only: a probe answer is not a verdict, so a decided probe is
          never shown as a pass.
        </p>
        <BankTable results={results} />
      </CollapsibleContent>
    </Collapsible>
  );
}
