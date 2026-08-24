"use client";

import { useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { useCallback, useState } from "react";
import { EmptyState } from "@/components/states/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ConnectPanel } from "@/features/claude-code/components/connect-panel";
import type { PersonalToken } from "@/lib/api/types";
import { useNow } from "@/lib/use-now";
import { myTokensQuery } from "../queries";
import { countActiveTokens, PERSONAL_TOKEN_LIMIT } from "../schemas";
import { RevokeTokenDialog, TokenTable } from "./token-table";

const CLOCK_INTERVAL_MS = 30_000;

function TokensSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading your tokens</span>
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

export function TokensView() {
  const now = useNow(CLOCK_INTERVAL_MS);
  const tokens = useQuery(myTokensQuery());
  const [revoking, setRevoking] = useState<PersonalToken | null>(null);
  const closeRevoke = useCallback(() => setRevoking(null), []);

  if (now === null) {
    return <TokensSkeleton />;
  }

  const rows = tokens.data;
  const hasTokens = rows !== undefined && rows.length > 0;
  const activeCount = rows === undefined ? 0 : countActiveTokens(rows, now);

  return (
    <div className="flex flex-col gap-6" data-slot="tokens-view">
      {rows !== undefined && !hasTokens ? <ConnectPanel /> : null}
      <section aria-label="Your tokens" className="flex flex-col gap-3">
        {hasTokens ? (
          <p className="text-sm text-muted-foreground" data-slot="token-count">
            {activeCount} of {PERSONAL_TOKEN_LIMIT} active tokens in use.
          </p>
        ) : null}
        <TokenTable
          rows={rows}
          now={now}
          isLoading={tokens.isPending}
          isFetching={tokens.isFetching}
          error={tokens.error}
          onRetry={() => void tokens.refetch()}
          onRevoke={setRevoking}
          emptyState={
            <EmptyState
              icon={KeyRound}
              title="No tokens yet"
              description="Create a token, then paste it into Claude Code when the plugin asks. Follow the three steps above."
            />
          }
        />
      </section>
      {hasTokens ? <ConnectPanel /> : null}
      <RevokeTokenDialog token={revoking} onClose={closeRevoke} />
    </div>
  );
}
