import { DatabaseZap } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/states/empty-state";
import { Button } from "@/components/ui/button";
import { targetRoutes } from "@/lib/routes";

export interface NoTemplatesStateProps {
  targetId: string;
}

export function NoTemplatesState({ targetId }: NoTemplatesStateProps) {
  return (
    <div data-slot="no-templates-state" className="flex flex-col gap-4">
      <EmptyState
        title="No oracle templates"
        description="Oracle templates come from the oracle/ folder of a valid bundle: one read-only query per expected value. This target has none yet. Re-run the Discovery prompt, or send the Fix-up prompt, so Claude Code writes them, then upload the new bundle."
        icon={DatabaseZap}
        action={
          <Button asChild>
            <Link href={targetRoutes.bundles(targetId)}>Open the bundles of this target</Link>
          </Button>
        }
      />
    </div>
  );
}
