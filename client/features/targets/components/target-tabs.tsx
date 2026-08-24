"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { targetRoutes } from "@/lib/routes";
import { cn } from "@/lib/utils";

export function targetTabs(targetId: string) {
  return [
    { id: "overview", label: "Overview", href: targetRoutes.detail(targetId), exact: true },
    { id: "bundles", label: "Bundles", href: targetRoutes.bundles(targetId), exact: false },
    {
      id: "environment",
      label: "Environment",
      href: targetRoutes.environment(targetId),
      exact: false,
    },
    { id: "proposal", label: "Proposal", href: targetRoutes.proposal(targetId), exact: false },
  ] as const;
}

export function isTargetTabActive(href: string, pathname: string, exact: boolean): boolean {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

export function TargetTabs({ targetId }: { targetId: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Target sections" className="border-b">
      <ul className="-mb-px flex flex-wrap gap-1">
        {targetTabs(targetId).map((tab) => {
          const active = isTargetTabActive(tab.href, pathname, tab.exact);
          return (
            <li key={tab.id}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-9 items-center border-b-2 px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  active
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
