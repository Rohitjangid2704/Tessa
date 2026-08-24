"use client";

import { Ban, CircleCheck, Clock } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { createDataTableColumnHelper, DataTable } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { StatusBadge } from "@/components/status/status-badge";
import { TypedConfirmDialog } from "@/components/typed-confirm-dialog";
import { Button } from "@/components/ui/button";
import { describeApiError } from "@/lib/api/errors";
import type { PersonalToken } from "@/lib/api/types";
import { useRevokeToken } from "../mutations";
import { tokenStateOf, type TokenState } from "../schemas";

const STATE_BADGES: Record<TokenState, { label: string; tone: "kpi-good" | "hollow" | "kpi-bad" }> =
  {
    active: { label: "Active", tone: "kpi-good" },
    expired: { label: "Expired", tone: "hollow" },
    revoked: { label: "Revoked", tone: "kpi-bad" },
  };

const STATE_ICONS = { active: CircleCheck, expired: Clock, revoked: Ban } as const;

export function TokenStateChip({ state }: { state: TokenState }) {
  const { label, tone } = STATE_BADGES[state];
  return <StatusBadge tone={tone} label={label} icon={STATE_ICONS[state]} />;
}

const helper = createDataTableColumnHelper<PersonalToken>();

export type TokenTableProps = {
  rows: readonly PersonalToken[] | undefined;
  now: number;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  onRetry: () => void;
  onRevoke: (token: PersonalToken) => void;
  emptyState: ReactNode;
};

export function TokenTable({
  rows,
  now,
  isLoading,
  isFetching,
  error,
  onRetry,
  onRevoke,
  emptyState,
}: TokenTableProps) {
  const columns = useMemo(
    () =>
      helper.columns([
        helper.accessor("name", {
          header: "Name",
          enableSorting: false,
          cell: (info) => <span className="font-medium">{info.getValue()}</span>,
        }),
        helper.accessor("prefix", {
          header: "Prefix",
          enableSorting: false,
          cell: (info) => <code className="font-mono text-xs">{info.getValue()}</code>,
        }),
        helper.display({
          id: "state",
          header: "State",
          cell: (info) => <TokenStateChip state={tokenStateOf(info.row.original, now)} />,
        }),
        helper.accessor("created_at", {
          header: "Created",
          enableSorting: false,
          cell: (info) => <DateTime value={info.getValue()} />,
        }),
        helper.accessor("expires_at", {
          header: "Expires",
          enableSorting: false,
          cell: (info) => <DateTime value={info.getValue()} />,
        }),
        helper.accessor("last_used_at", {
          header: "Last used",
          enableSorting: false,
          cell: (info) => <DateTime value={info.getValue()} fallback="Never" />,
        }),
        helper.display({
          id: "actions",
          header: () => <span className="sr-only">Actions</span>,
          meta: { align: "end" },
          cell: (info) => {
            const token = info.row.original;
            if (tokenStateOf(token, now) !== "active") {
              return null;
            }
            return (
              <Button type="button" variant="outline" size="sm" onClick={() => onRevoke(token)}>
                Revoke
                <span className="sr-only"> {token.name}</span>
              </Button>
            );
          },
        }),
      ]),
    [now, onRevoke],
  );

  return (
    <DataTable<PersonalToken>
      label="Personal tokens"
      columns={columns}
      data={rows}
      getRowId={(row) => row.id}
      isLoading={isLoading}
      isFetching={isFetching}
      error={error}
      onRetry={onRetry}
      emptyState={emptyState}
      getRowProps={(row) => ({
        "data-token-id": row.id,
        "data-state": tokenStateOf(row, now),
      })}
    />
  );
}

export type RevokeTokenDialogProps = {
  token: PersonalToken | null;
  onClose: () => void;
};

export function RevokeTokenDialog({ token, onClose }: RevokeTokenDialogProps) {
  const revoke = useRevokeToken();
  const [error, setError] = useState<string | null>(null);

  function close(): void {
    setError(null);
    revoke.reset();
    onClose();
  }

  function confirm(): void {
    if (token === null) {
      return;
    }
    setError(null);
    revoke.mutate(token.id, {
      onSuccess: close,
      onError: (failure) => setError(describeApiError(failure)),
    });
  }

  return (
    <TypedConfirmDialog
      open={token !== null}
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
      title="Revoke this token"
      description={
        <p>
          Claude Code sessions that use this token stop working right away. This cannot be undone;
          create a new token if you need one again.
        </p>
      }
      expectedText={token?.name ?? ""}
      confirmLabel="Revoke token"
      pendingLabel="Revoking"
      pending={revoke.isPending}
      error={error}
      onConfirm={confirm}
    />
  );
}
