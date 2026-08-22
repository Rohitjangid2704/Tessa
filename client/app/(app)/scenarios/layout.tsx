import { Suspense, type ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { ScenariosShell } from "@/features/scenarios/components/scenarios-shell";

function ScenariosShellFallback() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3 pb-6">
      <span className="sr-only">Loading scenarios</span>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-9 w-64" />
    </div>
  );
}

export default function ScenariosLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Suspense fallback={<ScenariosShellFallback />}>
        <ScenariosShell />
      </Suspense>
      {children}
    </>
  );
}
