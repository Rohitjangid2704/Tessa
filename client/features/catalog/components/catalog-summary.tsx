"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { AdapterChip } from "@/features/adapters/components/adapter-chip";
import { pluralize } from "@/features/bundles/format";
import { targetRoutes } from "@/lib/routes";
import type { CatalogInterface, CatalogRole } from "../types";

export interface CatalogSummaryProps {
  targetId: string;
  bundleId: string;
  bundleVersion: number;
  featureCount: number;
  areaCount: number;
  roles: readonly CatalogRole[];
  interfaces: readonly CatalogInterface[];
}

export function CatalogSummary({
  targetId,
  bundleId,
  bundleVersion,
  featureCount,
  areaCount,
  roles,
  interfaces,
}: CatalogSummaryProps) {
  const [open, setOpen] = useState(false);

  return (
    <section aria-label="Catalog summary" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="font-medium">Bundle version {bundleVersion}</span>
        <span className="text-muted-foreground tabular-nums">
          {pluralize(featureCount, "feature")}, {pluralize(areaCount, "area")},{" "}
          {pluralize(roles.length, "role")}, {pluralize(interfaces.length, "interface")}
        </span>
        <Link
          href={targetRoutes.bundle(targetId, bundleId)}
          className="underline underline-offset-4"
        >
          View bundle
        </Link>
      </div>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="-ml-2">
            <ChevronDown
              aria-hidden="true"
              className={open ? "rotate-180 transition-transform" : "transition-transform"}
            />
            Roles and interfaces
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="grid gap-6 pt-2 text-sm md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Roles
              </h2>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                {roles.map((role) => (
                  <div key={role.id} className="contents">
                    <dt className="font-mono text-xs">{role.id}</dt>
                    <dd className="text-muted-foreground">
                      Level {role.level}
                      {role.description ? `, ${role.description}` : ""}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
            <div className="flex flex-col gap-1.5">
              <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Interfaces
              </h2>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                {interfaces.map((entry) => (
                  <div key={entry.id} className="contents">
                    <dt className="font-mono text-xs">{entry.id}</dt>
                    <dd className="flex flex-wrap items-center gap-2 text-muted-foreground">
                      <AdapterChip kind={entry.kind} />
                      <span className="font-mono text-xs">{entry.base_path}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
