"use client";

import { ChevronDown, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { readRequestId } from "@/components/states/request-id";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { describeApiError } from "@/lib/api/errors";
import type { Scenario, ScenarioPatchStatus, ScenarioStatus } from "@/lib/api/types";
import { useCan } from "@/lib/auth/can";
import { useScenarioStatus } from "../mutations";

export interface StatusAction {
  status: ScenarioPatchStatus;
  label: string;
  title: string;
  description: string;
}

const QUARANTINE: StatusAction = {
  status: "quarantined",
  label: "Quarantine",
  title: "Quarantine this scenario?",
  description:
    "A quarantined scenario stays in the library but is skipped by new runs until you accept it again. Use it for a scenario that fails for reasons you are still investigating.",
};

const ACCEPT_FROM_QUARANTINE: StatusAction = {
  status: "accepted",
  label: "Accept again",
  title: "Take this scenario out of quarantine?",
  description: "The scenario is accepted again and new runs include it.",
};

const RETIRE: StatusAction = {
  status: "retired",
  label: "Retire",
  title: "Retire this scenario?",
  description:
    "A retired scenario is read-only and never runs again. Its history and versions stay available.",
};

export function statusActionsFor(status: ScenarioStatus): readonly StatusAction[] {
  switch (status) {
    case "accepted":
      return [QUARANTINE, RETIRE];
    case "quarantined":
      return [ACCEPT_FROM_QUARANTINE, RETIRE];
    case "retired":
      return [];
    default:
      return [RETIRE];
  }
}

export type StatusMenuProps = {
  scenario: Pick<Scenario, "id" | "status" | "title">;
};

export function StatusMenu({ scenario }: StatusMenuProps) {
  const canChange = useCan("scenarios.set_status");
  const change = useScenarioStatus(scenario.id);
  const [pending, setPending] = useState<StatusAction | null>(null);
  const actions = statusActionsFor(scenario.status);

  if (actions.length === 0) {
    return null;
  }

  function confirm(): void {
    if (pending === null || change.isPending) {
      return;
    }
    change.mutate({ status: pending.status }, { onSuccess: () => setPending(null) });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={!canChange}
            title={canChange ? undefined : "Viewers cannot change the status of a scenario"}
          >
            Status
            <ChevronDown aria-hidden="true" data-icon="inline-end" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Change the status</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {actions.map((action) => (
            <DropdownMenuItem
              key={action.status}
              onSelect={() => {
                change.reset();
                setPending(action);
              }}
            >
              {action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !change.isPending) {
            setPending(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {`"${scenario.title}". ${pending?.description ?? ""}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {change.isError ? (
            <div role="alert" className="flex flex-col gap-1 text-sm text-destructive">
              <p>{describeApiError(change.error)}</p>
              {readRequestId(change.error) === null ? null : (
                <p className="font-mono text-xs text-muted-foreground">
                  Request ID: {readRequestId(change.error)}
                </p>
              )}
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={change.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={change.isPending}
              aria-busy={change.isPending}
              onClick={(event) => {
                event.preventDefault();
                confirm();
              }}
            >
              {change.isPending ? (
                <LoaderCircle aria-hidden="true" data-icon="inline-start" className="animate-spin" />
              ) : null}
              {pending?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
