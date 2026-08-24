"use client";

import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldDescription, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError, isApiError } from "@/lib/api/errors";
import type { Team, User } from "@/lib/api/types";
import { describeTeamFailure } from "../labels";
import { useSetTeamMembers } from "../mutations";
import { teamUserOptionsQuery, type TeamUserOptions } from "../queries";

export type MembersEditorProps = {
  team: Team;
  onClose: () => void;
};

function sortUsers(users: readonly User[]): User[] {
  return [...users].sort(
    (left, right) =>
      left.name.localeCompare(right.name, "en") || left.email.localeCompare(right.email, "en"),
  );
}

function matchesFilter(user: User, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  return (
    needle === "" ||
    user.name.toLowerCase().includes(needle) ||
    user.email.toLowerCase().includes(needle)
  );
}

function memberIdsOf(users: readonly User[], teamId: string): Set<string> {
  return new Set(users.filter((user) => user.team_ids.includes(teamId)).map((user) => user.id));
}

function sameMembers(selected: ReadonlySet<string>, initial: ReadonlySet<string>): boolean {
  return selected.size === initial.size && [...selected].every((userId) => initial.has(userId));
}

function MembersSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">Loading users</span>
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

type MemberChecklistProps = {
  team: Team;
  options: TeamUserOptions;
  onClose: () => void;
};

function MemberChecklist({ team, options, onClose }: MemberChecklistProps) {
  const listId = useId();
  const filterId = useId();
  const setMembers = useSetTeamMembers();
  const [initialMembers] = useState<ReadonlySet<string>>(() =>
    memberIdsOf(options.users, team.id),
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(initialMembers);
  const [filter, setFilter] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const users = sortUsers(options.users);
  const visible = users.filter((user) => matchesFilter(user, filter));
  const unchanged = sameMembers(selected, initialMembers);
  const canSave = options.complete && !unchanged && !setMembers.isPending;

  function toggle(userId: string, checked: boolean): void {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(userId);
      } else {
        next.delete(userId);
      }
      return next;
    });
  }

  function save(): void {
    setFormError(null);
    setMembers.mutate(
      { teamId: team.id, userIds: [...selected] },
      {
        onSuccess: (saved) => {
          toast.success(`Members of ${saved.name} saved`);
          onClose();
        },
        onError: (error) => {
          setFormError(
            isApiError(error) && error.status === 422
              ? describeApiError(error)
              : describeTeamFailure("members", error),
          );
        },
      },
    );
  }

  return (
    <>
      <div className="flex flex-col gap-3">
        {formError === null ? null : (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}
        {options.complete ? null : (
          <Alert>
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>
              Only the first {users.length} users could be loaded. Saving would drop the others from
              the team, so members cannot be edited here until the list is complete.
            </AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={filterId}>Filter users</Label>
          <Input
            id={filterId}
            type="search"
            autoComplete="off"
            placeholder="Name or email"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        <FieldSet data-slot="member-checklist">
          <FieldLegend variant="label">Members of {team.name}</FieldLegend>
          {users.length === 0 ? (
            <p className="text-sm text-muted-foreground">There are no users to add yet.</p>
          ) : visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">No user matches this filter.</p>
          ) : (
            <ul className="flex max-h-72 flex-col overflow-y-auto rounded-lg border">
              {visible.map((user) => {
                const checkboxId = `${listId}-${user.id}`;
                return (
                  <li
                    key={user.id}
                    data-slot="member-row"
                    data-user-id={user.id}
                    className="flex items-center gap-3 border-b px-3 py-2 last:border-b-0"
                  >
                    <Checkbox
                      id={checkboxId}
                      checked={selected.has(user.id)}
                      onCheckedChange={(checked) => toggle(user.id, checked === true)}
                    />
                    <Label
                      htmlFor={checkboxId}
                      className="flex min-w-0 flex-1 flex-col items-start gap-0.5 font-normal"
                    >
                      <span className="max-w-full truncate font-medium">{user.name}</span>
                      <span className="max-w-full truncate text-xs text-muted-foreground">
                        {user.email}, {user.role}
                        {user.is_active ? "" : ", inactive"}
                      </span>
                    </Label>
                  </li>
                );
              })}
            </ul>
          )}
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {selected.size} of {users.length} users selected
          </p>
          <FieldDescription>
            Saving replaces the member list: anyone left unchecked is removed from this team. Team
            membership never limits what a user can see.
          </FieldDescription>
        </FieldSet>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" disabled={!canSave} onClick={save}>
          {setMembers.isPending ? "Saving" : "Save members"}
        </Button>
      </DialogFooter>
    </>
  );
}

export function MembersEditor({ team, onClose }: MembersEditorProps) {
  const users = useQuery(teamUserOptionsQuery());

  let body: ReactNode;
  if (users.isPending) {
    body = (
      <>
        <MembersSkeleton />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </>
    );
  } else if (users.isError) {
    body = (
      <>
        <ErrorState
          title="Could not load the users"
          description={describeApiError(users.error)}
          requestId={readRequestId(users.error)}
          retryLabel={users.isFetching ? "Retrying" : "Retry"}
          onRetry={() => void users.refetch()}
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </>
    );
  } else {
    body = <MemberChecklist key={team.id} team={team} options={users.data} onClose={onClose} />;
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Members of {team.name}</DialogTitle>
          <DialogDescription>Choose who belongs to this team.</DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
