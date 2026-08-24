"use client";

import Link from "next/link";
import { useId } from "react";
import { SeverityBadge } from "@/components/status/severity-badge";
import { findingRoutes } from "@/lib/routes";
import type { LandedFinding } from "../model";

export type LandedFindingsProps = {
  findings: readonly LandedFinding[];
  runActive: boolean;
};

export function LandedFindings({ findings, runActive }: LandedFindingsProps) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-slot="landed-findings"
      className="flex flex-col gap-2"
    >
      <h2 id={headingId} className="text-base font-semibold">
        Findings from this run
      </h2>
      {findings.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {runActive
            ? "None yet. A breach becomes a finding only after the skeptic confirms it."
            : "No breach was confirmed by the skeptic, so nothing reached the board."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {findings.map((finding) => (
            <li key={finding.id} className="flex flex-wrap items-center gap-2 text-sm">
              <SeverityBadge severity={finding.severity} />
              <Link
                href={findingRoutes.detail(finding.id)}
                className="font-medium underline-offset-4 hover:underline"
              >
                {finding.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
