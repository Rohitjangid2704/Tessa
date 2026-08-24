"use client";

import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { RoleGate } from "@/components/role-gate";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import { settingsRoutes } from "@/lib/routes";
import { describeTeamFailure } from "@/features/teams/labels";
import { useSetTargetTeam } from "@/features/teams/mutations";
import { teamsQuery } from "@/features/teams/queries";
import { teamIdOfTarget } from "@/features/teams/target-team";
import type { Target } from "../types";

const NO_TEAM_VALUE = "none";

function TeamSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-2">
      <span className="sr-only">Loading teams</span>
      <Skeleton className="h-8 w-full sm:w-64" />
    </div>
  );
}

function TargetTeamControl({ target }: { target: Target }) {
  const selectId = useId();
  const teams = useQuery(teamsQuery());
  const setTeam = useSetTargetTeam(target.id);
  const currentTeamId = teamIdOfTarget(target);
  const [draft, setDraft] = useState<string | null | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const archived = target.archived_at != null;
  const selected = draft === undefined ? currentTeamId : draft;
  const changed = selected !== currentTeamId;
  const items = teams.data?.items ?? [];
  const selectedTeam = items.find((team) => team.id === selected);
  const selectedLabel = selected === null ? "No team" : (selectedTeam?.name ?? "Unknown team");

  function save(): void {
    setFormError(null);
    setTeam.mutate(selected, {
      onSuccess: () => {
        setDraft(undefined);
        toast.success(
          selectedTeam === undefined
            ? "Target removed from its team"
            : `Target moved to team ${selectedTeam.name}`,
        );
      },
      onError: (error) => setFormError(describeTeamFailure("target", error)),
    });
  }

  let body: ReactNode;
  if (teams.isPending) {
    body = <TeamSkeleton />;
  } else if (teams.isError) {
    body = (
      <Alert variant="destructive">
        <TriangleAlert aria-hidden="true" />
        <AlertDescription className="flex flex-wrap items-center gap-2">
          <span>Could not load the teams. {describeApiError(teams.error)}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void teams.refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else if (items.length === 0) {
    body = (
      <p className="text-sm text-muted-foreground">
        No teams exist yet.{" "}
        <Link href={settingsRoutes.teams()} className="underline underline-offset-4">
          Create a team in the team settings
        </Link>{" "}
        first.
      </p>
    );
  } else {
    body = (
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={selected ?? NO_TEAM_VALUE}
          disabled={archived || setTeam.isPending}
          onValueChange={(value) => setDraft(value === NO_TEAM_VALUE ? null : value)}
        >
          <SelectTrigger id={selectId} className="w-full sm:w-64">
            <SelectValue placeholder="No team">{selectedLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            <SelectItem value={NO_TEAM_VALUE}>No team</SelectItem>
            {items.map((team) => (
              <SelectItem key={team.id} value={team.id}>
                {team.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          size="sm"
          disabled={archived || !changed || setTeam.isPending}
          onClick={save}
        >
          {setTeam.isPending ? "Saving" : "Save team"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!changed || setTeam.isPending}
          onClick={() => {
            setDraft(undefined);
            setFormError(null);
          }}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div data-slot="target-team-field" className="flex flex-col gap-2">
      <Label htmlFor={selectId}>Team</Label>
      {body}
      {formError === null ? null : (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}
      <p className="text-sm text-muted-foreground">
        {archived
          ? "An archived target cannot change team."
          : "The team's monthly budget limits runs on this target. Teams never limit who can see it."}
      </p>
    </div>
  );
}

export function TargetTeamField({ target }: { target: Target }) {
  return (
    <RoleGate action="targets.set_team">
      <TargetTeamControl target={target} />
    </RoleGate>
  );
}
