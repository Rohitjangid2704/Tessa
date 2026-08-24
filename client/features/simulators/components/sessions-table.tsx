"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { MessagesSquare } from "lucide-react";
import Link from "next/link";
import { createDataTableColumnHelper, DataTable, DataTableFooter } from "@/components/data-table";
import { EmptyState } from "@/components/states/empty-state";
import { VerdictBadge } from "@/components/status/verdict-badge";
import { Button } from "@/components/ui/button";
import { runRoutes } from "@/lib/routes";
import { useHydrated } from "@/lib/use-hydrated";
import { simSessionsQuery } from "../queries";
import { useSimulatorNames, type SimulatorNames } from "../use-simulator-names";
import type { SimSession } from "../types";
import { ChecksStrip } from "./checks-strip";

const helper = createDataTableColumnHelper<SimSession>();

function sessionColumns(names: SimulatorNames, onOpen: (sessionId: string) => void) {
  return [
    helper.display({
      id: "persona",
      header: "Persona",
      enableSorting: false,
      cell: (info) => (
        <span className="font-medium">
          {names.personaName(info.row.original.persona_id) ?? "Removed persona"}
        </span>
      ),
    }),
    helper.display({
      id: "goal",
      header: "Goal",
      enableSorting: false,
      cell: (info) => names.goalTitle(info.row.original.goal_id) ?? "Removed goal",
    }),
    helper.display({
      id: "attempt",
      header: "Attempt",
      enableSorting: false,
      cell: (info) => <span className="tabular-nums">{info.row.original.attempt + 1}</span>,
    }),
    helper.display({
      id: "verdict",
      header: "Verdict",
      enableSorting: false,
      cell: (info) => <VerdictBadge verdict={info.row.original.verdict.status} />,
    }),
    helper.display({
      id: "checks",
      header: "Checks",
      enableSorting: false,
      cell: (info) => <ChecksStrip checks={info.row.original.checks} className="min-w-72" />,
    }),
    helper.display({
      id: "run",
      header: "Run",
      enableSorting: false,
      cell: (info) => (
        <Link
          href={runRoutes.detail(info.row.original.run_id)}
          className="text-xs underline underline-offset-4"
        >
          Open run
        </Link>
      ),
    }),
    helper.display({
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      enableSorting: false,
      meta: { align: "end" },
      cell: (info) => {
        const session = info.row.original;
        return (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Read the conversation of attempt ${session.attempt + 1}`}
            onClick={() => onOpen(session.id)}
          >
            Read
          </Button>
        );
      },
    }),
  ];
}

export interface SessionsTableProps {
  targetId: string;
  onOpen: (sessionId: string) => void;
}

export function SessionsTable({ targetId, onOpen }: SessionsTableProps) {
  const hydrated = useHydrated();
  const names = useSimulatorNames(targetId);
  const query = useInfiniteQuery(simSessionsQuery());
  const rows = query.data?.items.filter(
    (session) => names.personaName(session.persona_id) !== null,
  );

  return (
    <section data-slot="sessions-table" aria-label="Simulation sessions" className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">Sessions</h2>
      <DataTable<SimSession>
        label="Simulation sessions"
        columns={sessionColumns(names, onOpen)}
        data={hydrated ? rows : undefined}
        getRowId={(row) => row.id}
        isLoading={!hydrated || query.isPending || names.isLoading}
        isFetching={hydrated && query.isFetching}
        error={hydrated ? query.error : null}
        onRetry={() => void query.refetch()}
        emptyState={
          <EmptyState
            icon={MessagesSquare}
            title="No sessions yet"
            description="Every attempt of a simulation leaves a session here once it has been checked."
          />
        }
        getRowProps={(row) => ({ "data-session-id": row.id, "data-verdict": row.verdict.status })}
        footer={
          <DataTableFooter
            noun="session"
            loadedCount={hydrated ? (rows?.length ?? 0) : 0}
            hasNextPage={hydrated && query.hasNextPage}
            isFetchingNextPage={query.isFetchingNextPage}
            onLoadMore={() => void query.fetchNextPage()}
          />
        }
      />
    </section>
  );
}
