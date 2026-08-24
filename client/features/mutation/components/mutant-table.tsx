"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { FlaskConical, Pencil, Play, Plus, Rocket } from "lucide-react";
import { useId, useState } from "react";
import { createDataTableColumnHelper, DataTable, DataTableFooter } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { EmptyState } from "@/components/states/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DeleteConfirm } from "@/features/simulators/components/delete-confirm";
import type { Target } from "@/features/targets/types";
import { useCanDo } from "@/lib/auth/can";
import { useHydrated } from "@/lib/use-hydrated";
import { mutantRunBlock } from "../model";
import { useDeleteMutant } from "../mutations";
import { mutantsQuery } from "../queries";
import { MUTANTS_PROMPT_ANCHOR } from "../schemas";
import type { Mutant } from "../types";
import { MutantFormDialog } from "./mutant-form-dialog";
import { MutantStatusBadge, MutationOutcomeBadge } from "./mutant-badges";
import { MutantStatusDialog } from "./mutant-status-dialog";
import { RunMutationDialog } from "./run-mutation-dialog";

type DialogState =
  | { kind: "new" }
  | { kind: "edit" | "status" | "run"; mutant: Mutant }
  | null;

export type MutantTableProps = {
  target: Target;
};

const helper = createDataTableColumnHelper<Mutant>();

function DeleteMutant({ mutant }: { mutant: Mutant }) {
  const remove = useDeleteMutant();
  return (
    <DeleteConfirm
      triggerLabel={`Delete ${mutant.name}`}
      title={`Delete ${mutant.name}?`}
      description="The mutant and its mutation runs are removed from this list and from the suite power. The branch itself is not touched."
      confirmLabel="Delete mutant"
      isPending={remove.isPending}
      error={remove.error}
      onConfirm={(onDeleted) => remove.mutate(mutant.id, { onSuccess: onDeleted })}
      onReset={() => remove.reset()}
    />
  );
}

interface RowActionsProps {
  mutant: Mutant;
  target: Target;
  onOpen: (state: Exclude<DialogState, null | { kind: "new" }>) => void;
}

function RowActions({ mutant, target, onOpen }: RowActionsProps) {
  const reasonId = useId();
  const runAccess = useCanDo("mutation.run");
  const writeAccess = useCanDo("mutants.write");
  const block = mutantRunBlock(mutant, target);
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-1">
        {runAccess.allowed ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={block !== null}
            aria-label={`Run ${mutant.name}`}
            aria-describedby={block === null ? undefined : reasonId}
            onClick={() => onOpen({ kind: "run", mutant })}
          >
            <Play aria-hidden="true" data-icon="inline-start" />
            Run
          </Button>
        ) : null}
        {writeAccess.allowed ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Change the deployment of ${mutant.name}`}
              onClick={() => onOpen({ kind: "status", mutant })}
            >
              <Rocket aria-hidden="true" data-icon="inline-start" />
              Deployment
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Edit ${mutant.name}`}
              onClick={() => onOpen({ kind: "edit", mutant })}
            >
              <Pencil aria-hidden="true" data-icon="inline-start" />
              Edit
            </Button>
            <DeleteMutant mutant={mutant} />
          </>
        ) : null}
      </div>
      {block === null || !runAccess.allowed ? null : (
        <span id={reasonId} className="text-xs text-muted-foreground">
          {block.short}
        </span>
      )}
    </div>
  );
}

function mutantColumns(
  showActions: boolean,
  target: Target,
  onOpen: RowActionsProps["onOpen"],
) {
  const base = [
    helper.display({
      id: "name",
      header: "Mutant",
      enableSorting: false,
      cell: (info) => {
        const mutant = info.row.original;
        return (
          <div className="flex min-w-56 flex-col gap-0.5">
            <span className="font-mono text-sm font-medium wrap-anywhere">{mutant.name}</span>
            <span className="line-clamp-2 text-xs text-muted-foreground">{mutant.description}</span>
            <span className="font-mono text-xs text-muted-foreground wrap-anywhere">
              {mutant.branch}
            </span>
          </div>
        );
      },
    }),
    helper.display({
      id: "expected_catchers",
      header: "Should be caught by",
      enableSorting: false,
      cell: (info) => (
        <div className="flex max-w-64 flex-wrap gap-1">
          {info.row.original.expected_catchers.map((invariantId) => (
            <Badge key={invariantId} variant="outline" className="font-mono">
              {invariantId}
            </Badge>
          ))}
        </div>
      ),
    }),
    helper.display({
      id: "status",
      header: "Deployment",
      enableSorting: false,
      cell: (info) => {
        const mutant = info.row.original;
        return (
          <div className="flex min-w-40 flex-col items-start gap-1">
            <MutantStatusBadge status={mutant.status} />
            {mutant.base_url === null ? null : (
              <span className="font-mono text-xs text-muted-foreground wrap-anywhere">
                {mutant.base_url}
              </span>
            )}
          </div>
        );
      },
    }),
    helper.display({
      id: "last_outcome",
      header: "Last outcome",
      enableSorting: false,
      cell: (info) => <MutationOutcomeBadge outcome={info.row.original.last_outcome} />,
    }),
    helper.display({
      id: "created_at",
      header: "Registered",
      enableSorting: false,
      cell: (info) => <DateTime value={info.row.original.created_at} className="text-xs" />,
    }),
  ];
  if (!showActions) {
    return base;
  }
  return [
    ...base,
    helper.display({
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      enableSorting: false,
      meta: { align: "end" },
      cell: (info) => <RowActions mutant={info.row.original} target={target} onOpen={onOpen} />,
    }),
  ];
}

export function MutantTable({ target }: MutantTableProps) {
  const hydrated = useHydrated();
  const writeAccess = useCanDo("mutants.write");
  const runAccess = useCanDo("mutation.run");
  const query = useInfiniteQuery(mutantsQuery(target.id));
  const [dialog, setDialog] = useState<DialogState>(null);
  const archived = target.archived_at !== null && target.archived_at !== undefined;
  const canRegister = writeAccess.allowed && !archived;
  const isViewer = !writeAccess.isPending && !writeAccess.allowed && !runAccess.allowed;
  const loaded = hydrated && !query.isPending;
  const nothingAtAll = loaded && !query.isError && query.data?.items.length === 0;

  function close(): void {
    setDialog(null);
  }

  const registerButton = canRegister ? (
    <Button type="button" onClick={() => setDialog({ kind: "new" })}>
      <Plus aria-hidden="true" data-icon="inline-start" />
      Register a mutant
    </Button>
  ) : null;

  return (
    <div data-slot="mutant-table" className="flex flex-col gap-4">
      {isViewer ? (
        <p role="status" data-slot="viewer-note" className="text-sm text-muted-foreground">
          You can read the mutants and their results. Registering, running or changing them needs
          the member role.
        </p>
      ) : null}
      {nothingAtAll ? (
        <EmptyState
          icon={FlaskConical}
          title="No mutants registered yet"
          description="Copy the Mutants prompt and let Claude Code build one broken branch per bug. When a branch is deployed to QA, register it here, or upload the bundle again with tessa/mutants.yaml."
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button asChild variant={canRegister ? "outline" : "default"}>
                <a href={`#${MUTANTS_PROMPT_ANCHOR}`}>Copy the Mutants prompt</a>
              </Button>
              {registerButton}
            </div>
          }
        />
      ) : (
        <>
          {registerButton === null ? null : <div className="flex justify-end">{registerButton}</div>}
          <DataTable<Mutant>
            label="Mutants"
            columns={mutantColumns(writeAccess.allowed || runAccess.allowed, target, setDialog)}
            data={hydrated ? query.data?.items : undefined}
            getRowId={(row) => row.id}
            isLoading={!hydrated || query.isPending}
            isFetching={hydrated && query.isFetching}
            error={hydrated ? query.error : null}
            onRetry={() => void query.refetch()}
            getRowProps={(row) => ({
              "data-mutant-id": row.id,
              "data-status": row.status,
              "data-outcome": row.last_outcome ?? "none",
            })}
            footer={
              <DataTableFooter
                noun="mutant"
                loadedCount={hydrated ? (query.data?.loadedCount ?? 0) : 0}
                total={query.data?.total}
                hasNextPage={hydrated && query.hasNextPage}
                isFetchingNextPage={query.isFetchingNextPage}
                onLoadMore={() => void query.fetchNextPage()}
              />
            }
          />
        </>
      )}
      {dialog?.kind === "new" ? (
        <MutantFormDialog targetId={target.id} mutant={null} onClose={close} />
      ) : null}
      {dialog?.kind === "edit" ? (
        <MutantFormDialog targetId={target.id} mutant={dialog.mutant} onClose={close} />
      ) : null}
      {dialog?.kind === "status" ? (
        <MutantStatusDialog mutant={dialog.mutant} onClose={close} />
      ) : null}
      {dialog?.kind === "run" ? (
        <RunMutationDialog target={target} mutant={dialog.mutant} onClose={close} />
      ) : null}
    </div>
  );
}
