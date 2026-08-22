import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { RedteamPage } from "@/features/redteam/components/redteam-page";

export const metadata: Metadata = { title: "Red team" };

function RedteamFallback() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading the red team page</span>
      <Skeleton className="h-6 w-64" />
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

export default function RedteamRoutePage() {
  return (
    <>
      <PageHeader
        title="Red team"
        description="An attacker model tries to make the target break its own rules, round after round. A second, independent skeptic model checks every breach, and only confirmed breaches reach the findings board."
      />
      <Suspense fallback={<RedteamFallback />}>
        <RedteamPage />
      </Suspense>
    </>
  );
}
