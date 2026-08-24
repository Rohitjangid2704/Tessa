"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useId, type ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { TargetTierBadge } from "@/features/targets/components/target-tier-badge";
import { useCurrentTarget } from "@/features/targets/current-target";
import { CurrentTargetGate } from "@/features/targets/current-target-gate";
import { targetQuery } from "@/features/targets/queries";
import { targetRoutes } from "@/lib/routes";
import { useUrlFilters } from "@/lib/url-state";
import { replayPageCodec } from "../schemas";
import { ReplayDetail } from "./replay-detail";
import { ReplayList } from "./replay-list";
import { ReplayUpload } from "./replay-upload";

type ReplayWorkspaceProps = {
  targetId: string;
  selectedId: string | undefined;
  detail: ReactNode;
};

function ReplayWorkspace({ targetId, selectedId, detail }: ReplayWorkspaceProps) {
  const uploadHeadingId = useId();
  const target = useQuery(targetQuery(targetId));

  return (
    <div data-slot="replay-workspace" className="flex min-w-0 flex-col gap-8">
      <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>Target</span>
        {target.data === undefined ? (
          <Skeleton className="h-4 w-24" />
        ) : (
          <>
            <Link
              href={targetRoutes.detail(targetId)}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {target.data.name}
            </Link>
            <TargetTierBadge tier={target.data.tier} />
          </>
        )}
      </p>
      <section aria-labelledby={uploadHeadingId} className="flex flex-col gap-3">
        <h2 id={uploadHeadingId} className="text-base font-semibold">
          Upload a production export
        </h2>
        <ReplayUpload targetId={targetId} />
      </section>
      <ReplayList targetId={targetId} selectedId={selectedId} />
      {detail}
    </div>
  );
}

export function ReplayPage() {
  const { values } = useUrlFilters(replayPageCodec);
  const current = useCurrentTarget();
  const replayId = values.replay_id;
  const detail =
    replayId === undefined ? null : <ReplayDetail key={replayId} replayId={replayId} />;

  if (replayId !== undefined && current.targetId === null && current.isResolved) {
    return <div data-slot="replay-workspace">{detail}</div>;
  }

  return (
    <CurrentTargetGate
      title="Choose a target"
      description="A replay turns a production export into candidate cases for one target. Pick a QA target to upload an export or to read earlier replays."
    >
      {(targetId) => (
        <ReplayWorkspace key={targetId} targetId={targetId} selectedId={replayId} detail={detail} />
      )}
    </CurrentTargetGate>
  );
}
