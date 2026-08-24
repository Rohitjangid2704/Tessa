"use client";

import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { teamsQuery } from "@/features/teams/queries";

const MAX_VISIBLE_TEAMS = 3;
const SHORT_ID_LENGTH = 8;

export function TeamChips({ teamIds }: { teamIds: readonly string[] }) {
  const teams = useQuery(teamsQuery());
  if (teamIds.length === 0) {
    return <span className="text-sm text-muted-foreground">No team</span>;
  }
  const names = new Map(
    (teams.data?.items ?? []).map((team): [string, string] => [team.id, team.name]),
  );
  const visible = teamIds.slice(0, MAX_VISIBLE_TEAMS);
  const hidden = teamIds.length - visible.length;
  return (
    <ul aria-label="Teams" data-slot="team-chips" className="flex flex-wrap items-center gap-1">
      {visible.map((teamId) => (
        <li key={teamId}>
          <Badge variant="outline">{names.get(teamId) ?? teamId.slice(0, SHORT_ID_LENGTH)}</Badge>
        </li>
      ))}
      {hidden > 0 ? (
        <li>
          <Badge variant="secondary">{`+${hidden} more`}</Badge>
        </li>
      ) : null}
    </ul>
  );
}
