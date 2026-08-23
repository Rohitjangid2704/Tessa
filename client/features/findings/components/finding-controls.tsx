"use client";

import { ChevronDown, Pencil, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { RequiresPermission } from "@/components/requires-permission";
import { readRequestId } from "@/components/states/request-id";
import { FindingStatusBadge } from "@/components/status/finding-status-badge";
import { SEVERITIES } from "@/components/status/status-types";
import { SeverityBadge } from "@/components/status/severity-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Finding, FindingStatus } from "@/lib/api/types";
import { useCanDo } from "@/lib/auth/can";
import { describeFindingUpdateError, useUpdateFindingDetail } from "../detail-mutations";
import { moveLabel, SEVERITY_LABELS, USER_TRANSITIONS } from "../detail-schemas";
import { KnownGapDialog, type KnownGapMode } from "./known-gap-dialog";

export interface FindingControlsProps {
  finding: Finding;
}

export function FindingControls({ finding }: FindingControlsProps) {
  const access = useCanDo("findings.update");
  const statusLabelId = useId();
  const severityLabelId = useId();
  const update = useUpdateFindingDetail(finding.id);
  const [gapOpen, setGapOpen] = useState(false);
  const [gapMode, setGapMode] = useState<KnownGapMode>("move");

  const busy = update.isPending;
  const disabled = !access.allowed || busy;
  const moves = USER_TRANSITIONS[finding.status];

  function chooseStatus(status: FindingStatus): void {
    if (status === "known_gap") {
      update.reset();
      setGapMode("move");
      setGapOpen(true);
      return;
    }
    update.mutate({ status });
  }

  function chooseSeverity(value: string): void {
    const severity = SEVERITIES.find((candidate) => candidate === value);
    if (severity !== undefined && severity !== finding.severity) {
      update.mutate({ severity });
    }
  }

  function editReason(): void {
    update.reset();
    setGapMode("edit");
    setGapOpen(true);
  }

  function submitReason(reason: string): void {
    const patch =
      gapMode === "move"
        ? { status: "known_gap" as const, known_gap_reason: reason }
        : { known_gap_reason: reason };
    update.mutate(patch, { onSuccess: () => setGapOpen(false) });
  }

  function handleGapOpenChange(next: boolean): void {
    setGapOpen(next);
    if (!next) {
      update.reset();
    }
  }

  return (
    <section
      aria-label="Triage controls"
      data-slot="finding-controls"
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="flex flex-col gap-1.5">
          <span id={statusLabelId} className="text-xs font-medium text-muted-foreground">
            Status
          </span>
          <div role="group" aria-labelledby={statusLabelId} className="flex items-center gap-2">
            <FindingStatusBadge status={finding.status} />
            <DropdownMenu>
              <RequiresPermission action="findings.update">
                {() => (
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="outline" size="sm" disabled={disabled}>
                      Move to
                      <ChevronDown aria-hidden="true" data-icon="inline-end" />
                    </Button>
                  </DropdownMenuTrigger>
                )}
              </RequiresPermission>
              <DropdownMenuContent align="start" className="w-52">
                {moves.map((status) => (
                  <DropdownMenuItem key={status} onSelect={() => chooseStatus(status)}>
                    {moveLabel(finding.status, status)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span id={severityLabelId} className="text-xs font-medium text-muted-foreground">
            Severity
          </span>
          <div role="group" aria-labelledby={severityLabelId} className="flex items-center gap-2">
            <SeverityBadge severity={finding.severity} />
            <Select value={finding.severity} onValueChange={chooseSeverity} disabled={disabled}>
              <RequiresPermission action="findings.update">
                {() => (
                  <SelectTrigger size="sm" aria-label="Change severity" className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                )}
              </RequiresPermission>
              <SelectContent>
                {SEVERITIES.map((severity) => (
                  <SelectItem key={severity} value={severity}>
                    {SEVERITY_LABELS[severity]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Resolved is never set by hand: a later run that passes every attempt moves a finding there.
      </p>
      {finding.status === "known_gap" ? (
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border bg-muted/40 px-3 py-2">
          <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
            <span className="text-xs font-medium text-muted-foreground">Known-gap reason</span>
            <p className="text-sm wrap-anywhere whitespace-pre-wrap">
              {finding.known_gap_reason ?? "No reason was recorded."}
            </p>
          </div>
          <RequiresPermission action="findings.update">
            {() => (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={editReason}
              >
                <Pencil aria-hidden="true" data-icon="inline-start" />
                Edit reason
              </Button>
            )}
          </RequiresPermission>
        </div>
      ) : null}
      {update.isError && !gapOpen ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Could not update the finding</AlertTitle>
          <AlertDescription>
            <p>{describeFindingUpdateError(update.error)}</p>
            {readRequestId(update.error) === null ? null : (
              <p className="font-mono text-xs">Request ID: {readRequestId(update.error)}</p>
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      <KnownGapDialog
        open={gapOpen}
        onOpenChange={handleGapOpenChange}
        mode={gapMode}
        initialReason={finding.known_gap_reason}
        pending={busy}
        error={gapOpen && update.isError ? update.error : null}
        onSubmit={submitReason}
      />
    </section>
  );
}
