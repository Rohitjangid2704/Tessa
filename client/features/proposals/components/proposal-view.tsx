"use client";

import { useQuery } from "@tanstack/react-query";
import { ClipboardList, Filter, KeyRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ClaudeCodeCommand } from "@/features/claude-code/components/claude-code-command";
import { describeApiError } from "@/lib/api/errors";
import { useCan } from "@/lib/auth/can";
import { catalogRoutes, settingsRoutes } from "@/lib/routes";
import { useUrlFilters } from "@/lib/url-state";
import { useProposalFeed } from "../feed";
import {
  applyProposalFilters,
  areaNamesOf,
  DEFAULT_PROPOSAL_SORT,
  groupItemsByArea,
  proposalFiltersCodec,
  sortProposalItems,
} from "../filters";
import { usePlanFromProposal, useUpdateProposalItem } from "../mutations";
import { proposalQuery } from "../queries";
import { selectedItemIds } from "../selection";
import type { ProposalItem, ProposalItemChoice } from "../types";
import { ProposalBoard } from "./proposal-board";
import { ProposalFilters } from "./proposal-filters";
import { ProposalFooter } from "./proposal-footer";
import { ProposalHeader } from "./proposal-header";

const SKELETON_CARDS = 4;

function ProposalSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">Loading the test proposal</span>
      <Skeleton aria-hidden="true" className="h-16 w-full" />
      {Array.from({ length: SKELETON_CARDS }, (_, index) => (
        <Skeleton key={index} aria-hidden="true" className="h-36 w-full rounded-xl" />
      ))}
    </div>
  );
}

function NoProposal() {
  return (
    <EmptyState
      data-slot="proposal-empty"
      icon={ClipboardList}
      title="No test proposal yet"
      description="Claude Code reads the repository of this target and writes a ranked list of what is worth testing. The team ticks the items here, then plans them or has Claude Code author them."
      action={
        <div className="flex flex-col items-center gap-3">
          <ClaudeCodeCommand template="propose" />
          <Button asChild variant="link" size="sm">
            <Link href={settingsRoutes.tokens()}>
              <KeyRound aria-hidden="true" data-icon="inline-start" />
              Connect Claude Code
            </Link>
          </Button>
        </div>
      }
    />
  );
}

interface ProposalContentProps {
  targetId: string;
  onRestartFeed: () => void;
}

function ProposalContent({ targetId, onRestartFeed }: ProposalContentProps) {
  const router = useRouter();
  const query = useQuery(proposalQuery(targetId));
  const stream = useProposalFeed(targetId);
  const canSelect = useCan("proposals.select");
  const { values, activeCount, setFilters, resetFilters } = useUrlFilters(proposalFiltersCodec);
  const { proposal, pendingIds, announcement, update } = useUpdateProposalItem(
    targetId,
    query.data ?? null,
  );
  const planning = usePlanFromProposal(targetId);

  if (query.isPending) {
    return <ProposalSkeleton />;
  }
  if (query.isError) {
    return (
      <ErrorState
        title="Could not load the test proposal"
        description={describeApiError(query.error)}
        requestId={readRequestId(query.error)}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (proposal === null) {
    return <NoProposal />;
  }

  const filtered = applyProposalFilters(proposal.items, values);
  const sorted = sortProposalItems(filtered, values.sort ?? DEFAULT_PROPOSAL_SORT);
  const groups = groupItemsByArea(sorted);
  const selectedIds = selectedItemIds(proposal.items);
  const allDeclined = proposal.items.every((item) => item.status === "declined");

  function change(
    items: readonly ProposalItem[],
    choice: ProposalItemChoice,
    note?: string | null,
  ): void {
    if (items.length === 0) {
      return;
    }
    void update({ ids: items.map((item) => item.id), choice, note });
  }

  function planFromSelection(): void {
    planning.createPlan({ itemIds: selectedIds }, (plan) => {
      toast.success(`Saved plan "${plan.name ?? "Untitled plan"}"`);
      router.push(catalogRoutes.plan(targetId, plan.id));
    });
  }

  return (
    <div data-slot="proposal-view" className="flex flex-col gap-4">
      <ProposalHeader
        proposal={proposal}
        items={proposal.items}
        stream={stream}
        onRestartFeed={onRestartFeed}
      />
      {allDeclined ? (
        <Alert role="status" data-slot="proposal-all-declined">
          <AlertTitle>Every item is declined</AlertTitle>
          <AlertDescription>
            Nothing is left to plan or author. Restore an item to bring it back, or propose again.
          </AlertDescription>
        </Alert>
      ) : null}
      <ProposalFilters
        values={values}
        onChange={(patch) => setFilters(patch)}
        onReset={() => resetFilters()}
        activeCount={activeCount}
        areas={areaNamesOf(proposal.items)}
      />
      {groups.length === 0 ? (
        <EmptyState
          icon={Filter}
          title="No items match the filters"
          description="Clear the filters to see every item of the proposal again."
          action={
            <Button type="button" variant="outline" onClick={() => resetFilters()}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <ProposalBoard
          targetId={targetId}
          groups={groups}
          canEdit={canSelect}
          pendingIds={pendingIds}
          onChange={change}
        />
      )}
      <ProposalFooter
        selectedIds={selectedIds}
        canPlan={canSelect}
        planning={planning.isPending}
        planError={planning.error}
        onPlan={planFromSelection}
      />
      <p role="status" className="sr-only" data-slot="proposal-announcement">
        {announcement}
      </p>
    </div>
  );
}

export function ProposalView({ targetId }: { targetId: string }) {
  const [feedEpoch, setFeedEpoch] = useState(0);
  return (
    <ProposalContent
      key={`${targetId}:${feedEpoch}`}
      targetId={targetId}
      onRestartFeed={() => setFeedEpoch((epoch) => epoch + 1)}
    />
  );
}
