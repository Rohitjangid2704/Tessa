import type { Metadata } from "next";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { ScenariosView } from "@/features/scenarios/components/scenarios-view";

export const metadata: Metadata = { title: "Scenarios" };

function ScenariosFallback() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading scenarios</span>
      <Skeleton className="h-8 w-full max-w-3xl" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

export default function ScenariosPage() {
  return (
    <Suspense fallback={<ScenariosFallback />}>
      <ScenariosView />
    </Suspense>
  );
}
