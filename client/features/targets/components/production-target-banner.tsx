"use client";

import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { targetRoutes } from "@/lib/routes";
import { useHydrated } from "@/lib/use-hydrated";
import { targetIdFromPath, useCurrentTarget } from "../current-target";
import { targetQuery } from "../queries";

export const PRODUCTION_BANNER_TEXT = "Production target: runs are read-only";

export function ProductionTargetBanner() {
  const hydrated = useHydrated();
  const pathname = usePathname();
  const { targetId } = useCurrentTarget();
  const target = useQuery({ ...targetQuery(targetId ?? ""), enabled: targetId !== null });
  const data = target.data;
  if (!hydrated || data === undefined || data.tier !== "production") {
    return null;
  }
  if (targetIdFromPath(pathname) === data.id) {
    return null;
  }
  return (
    <div
      role="status"
      data-slot="production-target-banner"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-tier-production-fg/25 bg-tier-production-bg px-4 py-1.5 text-sm text-tier-production-fg"
    >
      <ShieldAlert aria-hidden="true" className="size-4 shrink-0" />
      <span className="font-medium">{PRODUCTION_BANNER_TEXT}</span>
      <span>{data.name}</span>
      <Link href={targetRoutes.detail(data.id)} className="underline underline-offset-3">
        Target settings
      </Link>
    </div>
  );
}
