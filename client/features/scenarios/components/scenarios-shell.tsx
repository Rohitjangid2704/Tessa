"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/app-shell/page-header";
import { Badge } from "@/components/ui/badge";
import { isTargetId, TARGET_ID_PARAM } from "@/features/targets/current-target";
import { routes, scenarioRoutes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { useHydrated } from "@/lib/use-hydrated";
import { reviewCountFilters, scenariosListQuery } from "../queries";
import { useScenarioFeed } from "../use-scenario-feed";
import { NewScenarioDialog } from "./new-scenario-dialog";

const REVIEW_PATH = `${routes.scenarios}/review`;

type ShellTab = "library" | "review";

const DESCRIPTIONS = {
  library: "The executable checks derived from the catalog. Open one to edit its YAML.",
  review:
    "Generated and authored scenarios wait here until a person accepts or rejects them. Nothing is accepted automatically.",
} as const satisfies Record<ShellTab, string>;

function activeTab(pathname: string): ShellTab | null {
  if (pathname === routes.scenarios) {
    return "library";
  }
  return pathname === REVIEW_PATH ? "review" : null;
}

function tabClasses(active: boolean): string {
  return cn(
    "inline-flex h-9 items-center gap-2 border-b-2 px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
    active
      ? "border-foreground text-foreground"
      : "border-transparent text-muted-foreground hover:text-foreground",
  );
}

export function ScenariosShell() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const hydrated = useHydrated();
  const rawTarget = searchParams?.get(TARGET_ID_PARAM) ?? null;
  const targetId = isTargetId(rawTarget) ? rawTarget : undefined;
  const tab = activeTab(pathname);
  const count = useInfiniteQuery({
    ...scenariosListQuery(reviewCountFilters(targetId), 1),
    enabled: tab !== null,
  });
  useScenarioFeed(hydrated && tab !== null ? targetId : null);
  const waiting = hydrated ? (count.data?.total ?? null) : null;

  if (tab === null) {
    return null;
  }

  return (
    <>
      <PageHeader
        title="Scenarios"
        description={DESCRIPTIONS[tab]}
        actions={<NewScenarioDialog targetId={targetId} />}
        className="pb-4"
      />
      <nav aria-label="Scenario sections" className="mb-6 border-b">
        <ul className="-mb-px flex flex-wrap gap-1">
          <li>
            <Link
              href={scenarioRoutes.list({ target_id: targetId })}
              aria-current={tab === "library" ? "page" : undefined}
              className={tabClasses(tab === "library")}
            >
              Library
            </Link>
          </li>
          <li>
            <Link
              href={scenarioRoutes.review({ target_id: targetId })}
              aria-current={tab === "review" ? "page" : undefined}
              className={tabClasses(tab === "review")}
            >
              Review
              {waiting === null || waiting === 0 ? null : (
                <Badge variant="secondary" data-slot="review-count">
                  {waiting}
                  <span className="sr-only"> waiting for review</span>
                </Badge>
              )}
            </Link>
          </li>
        </ul>
      </nav>
    </>
  );
}
