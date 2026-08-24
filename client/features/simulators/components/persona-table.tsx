"use client";

import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { Pencil, Plus, UserRound } from "lucide-react";
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
import { useDeletePersona } from "../mutations";
import { personasQuery } from "../queries";
import { simulatorsCodec } from "../schemas";
import type { Persona } from "../types";
import { DeleteConfirm } from "./delete-confirm";
import { PersonaForm } from "./persona-form";

type FilterKey = "q";

const FILTER_FIELDS: readonly FilterField<FilterKey>[] = [
  { type: "text", key: "q", label: "Search personas", placeholder: "Name or description" },
];

const TRAIT_BADGES_SHOWN = 4;
const TRAIT_VALUE_MAX_CHARS = 32;

const helper = createDataTableColumnHelper<Persona>();

function traitText(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const shown = text ?? String(value);
  return shown.length > TRAIT_VALUE_MAX_CHARS ? `${shown.slice(0, TRAIT_VALUE_MAX_CHARS)}…` : shown;
}

export function TraitBadges({ traits }: { traits: Persona["traits"] }) {
  const entries = Object.entries(traits);
  if (entries.length === 0) {
    return <span className="text-muted-foreground">None</span>;
  }
  return (
    <ul aria-label="Traits" className="flex flex-wrap gap-1">
      {entries.slice(0, TRAIT_BADGES_SHOWN).map(([name, value]) => (
        <li key={name}>
          <Badge variant="outline">
            {name}: {traitText(value)}
          </Badge>
        </li>
      ))}
      {entries.length > TRAIT_BADGES_SHOWN ? (
        <li className="text-xs text-muted-foreground">
          +{entries.length - TRAIT_BADGES_SHOWN} more
        </li>
      ) : null}
    </ul>
  );
}

function DeletePersona({ persona }: { persona: Persona }) {
  const remove = useDeletePersona();
  return (
    <DeleteConfirm
      triggerLabel={`Delete ${persona.name}`}
      title={`Delete ${persona.name}?`}
      description="Simulations can no longer use this persona. Sessions that already ran with it keep their transcripts, and a persona with sessions cannot be deleted."
      confirmLabel="Delete persona"
      isPending={remove.isPending}
      error={remove.error}
      onConfirm={(onDeleted) => remove.mutate(persona.id, { onSuccess: onDeleted })}
      onReset={() => remove.reset()}
    />
  );
}

function personaColumns(canEdit: boolean, onEdit: (persona: Persona) => void) {
  const base = [
    helper.display({
      id: "name",
      header: "Persona",
      enableSorting: false,
      cell: (info) => {
        const persona = info.row.original;
        return (
          <div className="flex min-w-48 flex-col gap-0.5">
            <span className="font-medium">{persona.name}</span>
            <span className="line-clamp-2 text-xs text-muted-foreground">
              {persona.description}
            </span>
          </div>
        );
      },
    }),
    helper.display({
      id: "traits",
      header: "Traits",
      enableSorting: false,
      cell: (info) => <TraitBadges traits={info.row.original.traits} />,
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
        const persona = info.row.original;
        return (
          <div className="flex items-center justify-end gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Edit ${persona.name}`}
              onClick={() => onEdit(persona)}
            >
              <Pencil aria-hidden="true" data-icon="inline-start" />
              Edit
            </Button>
            <DeletePersona persona={persona} />
          </div>
        );
      },
    }),
  ];
}

export interface PersonaTableProps {
  targetId: string;
}

export function PersonaTable({ targetId }: PersonaTableProps) {
  const hydrated = useHydrated();
  const { allowed: canEdit, isPending: rolePending } = useCanDo("personas.write");
  const filters = useUrlFilters(simulatorsCodec);
  const [editing, setEditing] = useState<Persona | "new" | null>(null);
  const query = useInfiniteQuery({
    ...personasQuery({ targetId, q: filters.values.q }),
    placeholderData: keepPreviousData,
  });
  const loaded = hydrated && !query.isPending;
  const total = query.data?.total;
  const hasQuery = filters.values.q !== undefined;
  const nothingAtAll = loaded && !query.isError && query.data?.items.length === 0 && !hasQuery;

  function closeDialog(): void {
    setEditing(null);
  }

  const newButton = canEdit ? (
    <Button type="button" onClick={() => setEditing("new")}>
      <Plus aria-hidden="true" data-icon="inline-start" />
      New persona
    </Button>
  ) : null;

  return (
    <div data-slot="persona-table" className="flex flex-col gap-4">
      {canEdit || rolePending ? null : (
        <p role="status" data-slot="viewer-note" className="text-sm text-muted-foreground">
          You can read personas. Creating, editing or deleting them needs the member role.
        </p>
      )}
      {nothingAtAll ? (
        <EmptyState
          icon={UserRound}
          title="Create a persona"
          description="A persona is the simulated user: who they are, how they write and how patient they are. Pair one with a goal to run a simulation."
          action={newButton ?? undefined}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <FilterBar
              label="Filter personas"
              fields={FILTER_FIELDS}
              values={filters.values}
              onChange={(patch) => filters.setFilters(patch)}
              onReset={() => filters.resetFilters()}
              activeCount={hasQuery ? 1 : 0}
            />
            {newButton}
          </div>
          <DataTable<Persona>
            label="Personas"
            columns={personaColumns(canEdit, setEditing)}
            data={hydrated ? query.data?.items : undefined}
            getRowId={(row) => row.id}
            isLoading={!hydrated || query.isPending}
            isFetching={hydrated && query.isFetching}
            error={hydrated ? query.error : null}
            onRetry={() => void query.refetch()}
            emptyState={
              <EmptyState
                icon={UserRound}
                title="No persona matches"
                description="Change the search to see more personas."
                action={
                  <Button type="button" variant="outline" onClick={() => filters.resetFilters()}>
                    Clear the search
                  </Button>
                }
              />
            }
            getRowProps={(row) => ({ "data-persona-id": row.id })}
            footer={
              <DataTableFooter
                noun="persona"
                loadedCount={hydrated ? (query.data?.loadedCount ?? 0) : 0}
                total={total}
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
            <DialogTitle>{editing === "new" ? "New persona" : "Edit persona"}</DialogTitle>
            <DialogDescription>
              The form comes from the published persona schema. The server checks every value
              again.
            </DialogDescription>
          </DialogHeader>
          {editing === null ? null : (
            <PersonaForm
              key={editing === "new" ? "new" : editing.id}
              targetId={targetId}
              persona={editing === "new" ? undefined : editing}
              onDone={closeDialog}
              onCancel={closeDialog}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
