"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ItemStatusBadge } from "@/features/proposals/components/proposal-badges";
import { proposalQuery } from "@/features/proposals/queries";
import { targetRoutes, withQuery } from "@/lib/routes";

export interface CellProposalItemsProps {
  targetId: string;
  itemIds: readonly string[];
}

export function CellProposalItems({ targetId, itemIds }: CellProposalItemsProps) {
  const query = useQuery({ ...proposalQuery(targetId), enabled: itemIds.length > 0 });
  if (itemIds.length === 0) {
    return null;
  }
  const items = new Map((query.data?.items ?? []).map((item) => [item.id, item]));

  return (
    <section data-slot="cell-proposal-items" className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Proposed in the test proposal</h3>
      {query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading the proposal items
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {itemIds.map((itemId) => {
            const item = items.get(itemId);
            return (
              <li key={itemId} className="flex flex-wrap items-center gap-2 text-sm">
                <Link
                  href={withQuery(targetRoutes.proposal(targetId), {
                    area: item?.area,
                  })}
                  className="underline underline-offset-4"
                >
                  {item?.title ?? "Item of the test proposal"}
                </Link>
                {item === undefined ? null : <ItemStatusBadge status={item.status} />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
