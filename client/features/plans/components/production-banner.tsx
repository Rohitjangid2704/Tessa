"use client";

import { ShieldAlert } from "lucide-react";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { targetRoutes } from "@/lib/routes";

export interface ProductionBannerProps {
  targetId: string;
  targetName: string;
  allowProduction: boolean;
}

export function ProductionBanner({ targetId, targetName, allowProduction }: ProductionBannerProps) {
  return (
    <Alert role="note" data-slot="production-banner">
      <ShieldAlert aria-hidden="true" />
      <AlertTitle>{targetName} is a production target</AlertTitle>
      <AlertDescription>
        <p>
          Runs here are read-only: write features are skipped and the seed cannot be reset.
          {allowProduction
            ? ""
            : " An admin has not enabled production runs for this target yet, so starting a run will be refused."}
        </p>
        {allowProduction ? null : (
          <p>
            <Link href={targetRoutes.detail(targetId)} className="underline underline-offset-3">
              Open the target settings
            </Link>
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}
