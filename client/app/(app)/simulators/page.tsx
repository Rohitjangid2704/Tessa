import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { SimulatorsView } from "@/features/simulators/components/simulators-view";

export const metadata: Metadata = { title: "Simulators" };

function SimulatorsFallback() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading the simulators</span>
      <Skeleton className="h-8 w-72" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export default function SimulatorsPage() {
  return (
    <>
      <PageHeader
        title="Simulators"
        description="Personas play simulated users, goals say what they try to achieve. Pair them in a simulation, watch the conversation live and read the five checks that decide the verdict."
      />
      <Suspense fallback={<SimulatorsFallback />}>
        <SimulatorsView />
      </Suspense>
    </>
  );
}
