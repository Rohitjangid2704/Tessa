"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, UsersRound } from "lucide-react";
import { useState } from "react";
import { DataTableFooter } from "@/components/data-table";
import { PageGate } from "@/components/page-gate";
import { EmptyState } from "@/components/states/empty-state";
import { Button } from "@/components/ui/button";
import { teamsQuery } from "../queries";
import { TeamFormDialog } from "./team-form-dialog";
import { TeamTable } from "./team-table";

function NewTeamButton({ onClick }: { onClick: () => void }) {
  return (
    <Button type="button" onClick={onClick}>
      <Plus aria-hidden="true" data-icon="inline-start" />
      New team
    </Button>
  );
}

function TeamsAdminView() {
  const teams = useQuery(teamsQuery());
  const [creating, setCreating] = useState(false);
  const items = teams.data?.items;

  return (
    <div data-slot="teams-view" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-sm text-muted-foreground">
          A team gives its targets one monthly budget. Runs that would take the team past it are
          refused, and a scheduled run that would is not started. Teams never limit who can see a
          target or its results.
        </p>
        <NewTeamButton onClick={() => setCreating(true)} />
      </div>
      <TeamTable
        rows={items}
        isLoading={teams.isPending}
        isFetching={teams.isFetching}
        error={teams.error}
        onRetry={() => void teams.refetch()}
        emptyState={
          <EmptyState
            icon={UsersRound}
            title="No teams: create one"
            description="Create a team, choose its members and give it a monthly budget. Then assign targets to it from each target's settings."
            action={<NewTeamButton onClick={() => setCreating(true)} />}
          />
        }
        footer={
          items === undefined ? null : (
            <DataTableFooter
              noun="team"
              loadedCount={items.length}
              total={teams.data?.total}
              hasNextPage={false}
              onLoadMore={() => undefined}
            />
          )
        }
      />
      {creating ? <TeamFormDialog team={null} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

export function TeamsView() {
  return (
    <PageGate action="teams.manage">
      <TeamsAdminView />
    </PageGate>
  );
}
