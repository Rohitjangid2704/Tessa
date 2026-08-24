import { DateTime } from "@/components/date-time";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { appKindLabel } from "../app-kinds";
import type { Target } from "../types";
import { TargetTierBadge } from "./target-tier-badge";

export function TargetHeader({ target }: { target: Target | undefined }) {
  if (target === undefined) {
    return (
      <header role="status" aria-busy="true" className="flex flex-col gap-2">
        <span className="sr-only">Loading the target</span>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </header>
    );
  }
  return (
    <header data-slot="target-header" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{target.name}</h1>
        <TargetTierBadge tier={target.tier} />
        {target.archived_at ? <Badge variant="outline">Archived</Badge> : null}
      </div>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span>{appKindLabel(target.app_kind)}</span>
        <span>
          Slug <code className="font-mono text-xs">{target.slug}</code>
        </span>
        <span>
          Created <DateTime value={target.created_at} />
        </span>
      </p>
    </header>
  );
}
