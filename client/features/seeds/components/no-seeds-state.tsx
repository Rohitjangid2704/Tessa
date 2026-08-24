import { Sprout } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/states/empty-state";
import { Button } from "@/components/ui/button";
import { targetRoutes } from "@/lib/routes";

export interface NoSeedsStateProps {
  targetId: string;
}

export function NoSeedsState({ targetId }: NoSeedsStateProps) {
  return (
    <EmptyState
      data-slot="no-seeds-state"
      title="No seed in the bundle"
      description="A seed is a reset script and a hash command declared in the seeds section of a valid bundle. This target has neither yet. Re-run the Discovery prompt, or send the Fix-up prompt, so Claude Code writes them, then upload the new bundle."
      icon={Sprout}
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button asChild>
            <Link href={targetRoutes.bundles(targetId)}>Open the bundles of this target</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={targetRoutes.detail(targetId)}>Open the target</Link>
          </Button>
        </div>
      }
    />
  );
}
