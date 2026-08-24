"use client";

import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { Pencil, Plus, Target } from "lucide-react";
import { useState } from "react";
import { createDataTableColumnHelper, DataTable, DataTableFooter } from "@/components/data-table";
import { FilterBar, type FilterField } from "@/components/filter-bar";
import { EmptyState } from "@/components/states/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCanDo } from "@/lib/auth/can";
import { useUrlFilters } from "@/lib/url-state";
import { useHydrated } from "@/lib/use-hydrated";
import { decidedByOf } from "../criteria";
import { useDeleteGoal } from "../mutations";
import { goalsQuery } from "../queries";
import { GOAL_KIND_HELP, GOAL_KIND_LABELS, GOAL_KINDS, simulatorsCodec } from "../schemas";
import type { Goal } from "../types";
import { DeleteConfirm } from "./delete-confirm";
import { GoalForm } from "./goal-form";

type FilterKey = "q" | "kind";

const FILTER_FIELDS: readonly FilterField<FilterKey>[] = [
  { type: "text", key: "q", label: "Search goals", placeholder: "Title or statement" },
  {
    type: "multi",
    key: "kind",
    label: "Kind",
    options: GOAL_KINDS.map((kind) => ({ value: kind, label: GOAL_KIND_LABELS[kind] })),
  },
];

const helper = createDataTableColumnHelper<Goal>();

export function CriteriaSummary({ criteria }: { criteria: readonly string[] }) {
  const byCode = criteria.filter((entry) => decidedByOf(entry) === "code").length;
  const byJudge = criteria.length - byCode;
  return (
    <span className="text-sm">
      {criteria.length} {criteria.length === 1 ? "criterion" : "criteria"}
      <span className="block text-xs text-muted-foreground">
        {byCode} by code, {byJudge} by the judge
      </span>
    </span>
  );
}

function DeleteGoal({ goal }: { goal: Goal }) {
  const remove = useDeleteGoal();
  return (
    <DeleteConfirm
      triggerLabel={`Delete ${goal.title}`}
      title={`Delete ${goal.title}?`}
      description="Simulations and explorations can no longer use this goal. Sessions that already ran with it keep their transcripts, and a goal with sessions cannot be deleted."
      confirmLabel="Delete goal"
      isPending={remove.isPending}
      error={remove.error}
      onConfirm={(onDeleted) => remove.mutate(goal.id, { onSuccess: onDeleted })}
      onReset={() => remove.reset()}
    />
  );
}

function goalColumns(canEdit: boolean, onEdit: (goal: Goal) => void) {
  const base = [
    helper.display({
      id: "title",
      header: "Goal",
      enableSorting: false,
      cell: (info) => {
        const goal = info.row.original;
        return (
          <div className="flex min-w-48 flex-col gap-0.5">
            <span className="font-medium">{goal.title}</span>
            <span className="line-clamp-2 text-xs text-muted-foreground">{goal.statement}</span>
          </div>
        );
      },
    }),
    helper.display({
      id: "kind",
      header: "Kind",
      enableSorting: false,
      cell: (info) => {
        const { kind } = info.row.original;
        return (
          <span className="flex max-w-56 flex-col items-start gap-1">
            <Badge variant="outline">{GOAL_KIND_LABELS[kind]}</Badge>
            <span className="text-xs text-muted-foreground">{GOAL_KIND_HELP[kind]}</span>
          </span>
        );
      },
    }),
    helper.display({
      id: "role",
      header: "Role",
      enableSorting: false,
      cell: (info) => {
        const { role } = info.row.original;
        return role === null ? (
          <span className="text-muted-foreground">Any</span>
        ) : (
          <span className="font-mono text-xs">{role}</span>
        );
      },
    }),
    helper.display({
      id: "criteria",
      header: "Success criteria",
      enableSorting: false,
      cell: (info) => <CriteriaSummary criteria={info.row.original.success_criteria} />,
    }),
  ];
  if (!canEdit) {
    return base;
  }
  return [
    ...base,
    helper.display({
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      enableSorting: false,
      meta: { align: "end" },
      cell: (info) => {
        const goal = info.row.original;
        return (
          <div className="flex items-center justify-end gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Edit ${goal.title}`}
              onClick={() => onEdit(goal)}
            >
              <Pencil aria-hidden="true" data-icon="inline-start" />
              Edit
            </Button>
            <DeleteGoal goal={goal} />
          </div>
        );
      },
    }),
  ];
}

export interface GoalTableProps {
  targetId: string;
}

export function GoalTable({ targetId }: GoalTableProps) {
  const hydrated = useHydrated();
  const { allowed: canEdit, isPending: rolePending } = useCanDo("goals.write");
  const filters = useUrlFilters(simulatorsCodec);
  const [editing, setEditing] = useState<Goal | "new" | null>(null);
  const query = useInfiniteQuery({
    ...goalsQuery({ targetId, q: filters.values.q, kind: filters.values.kind }),
    placeholderData: keepPreviousData,
  });
  const activeCount = (filters.values.q === undefined ? 0 : 1) + (filters.values.kind === undefined ? 0 : 1);
  const loaded = hydrated && !query.isPending;
  const nothingAtAll = loaded && !query.isError && query.data?.items.length === 0 && activeCount === 0;

  function closeDialog(): void {
    setEditing(null);
  }

  const newButton = canEdit ? (
    <Button type="button" onClick={() => setEditing("new")}>
      <Plus aria-hidden="true" data-icon="inline-start" />
      New goal
    </Button>
  ) : null;

  return (
    <div data-slot="goal-table" className="flex flex-col gap-4">
      {canEdit || rolePending ? null : (
        <p role="status" data-slot="viewer-note" className="text-sm text-muted-foreground">
          You can read goals. Creating, editing or deleting them needs the member role.
        </p>
      )}
      {nothingAtAll ? (
        <EmptyState
          icon={Target}
          title="Create a goal"
          description="A goal says what the simulated user tries to achieve and how success is decided: by code (db:, tool:, text:) or by the judge (judge:)."
          action={newButton ?? undefined}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <FilterBar
              label="Filter goals"
              fields={FILTER_FIELDS}
              values={filters.values}
              onChange={(patch) => filters.setFilters(patch)}
              onReset={() => filters.resetFilters()}
              activeCount={activeCount}
            />
            {newButton}
          </div>
          <DataTable<Goal>
            label="Goals"
            columns={goalColumns(canEdit, setEditing)}
            data={hydrated ? query.data?.items : undefined}
            getRowId={(row) => row.id}
            isLoading={!hydrated || query.isPending}
            isFetching={hydrated && query.isFetching}
            error={hydrated ? query.error : null}
            onRetry={() => void query.refetch()}
            emptyState={
              <EmptyState
                icon={Target}
                title="No goal matches"
                description="Change or clear the filters to see more goals."
                action={
                  <Button type="button" variant="outline" onClick={() => filters.resetFilters()}>
                    Clear filters
                  </Button>
                }
              />
            }
            getRowProps={(row) => ({ "data-goal-id": row.id, "data-kind": row.kind })}
            footer={
              <DataTableFooter
                noun="goal"
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
      <Dialog open={editing !== null} onOpenChange={(open) => (open ? undefined : closeDialog())}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing === "new" ? "New goal" : "Edit goal"}</DialogTitle>
            <DialogDescription>
              The form comes from the published goal schema. The server checks every value again.
            </DialogDescription>
          </DialogHeader>
          {editing === null ? null : (
            <GoalForm
              key={editing === "new" ? "new" : editing.id}
              targetId={targetId}
              goal={editing === "new" ? undefined : editing}
              onDone={closeDialog}
              onCancel={closeDialog}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
