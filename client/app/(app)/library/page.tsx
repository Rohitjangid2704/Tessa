import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { LibraryView } from "@/features/library/components/library-view";

export const metadata: Metadata = { title: "Library" };

function LibraryFallback() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading the bundle library</span>
      <Skeleton className="h-8 w-full max-w-3xl" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

export default function LibraryPage() {
  return (
    <>
      <PageHeader
        title="Library"
        description="Every bundle version across your targets. Open one, compare it with another version, use it in a contract check, or import new versions from git."
      />
      <Suspense fallback={<LibraryFallback />}>
        <LibraryView />
      </Suspense>
    </>
  );
}
