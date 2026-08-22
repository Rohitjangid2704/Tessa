import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-shell/page-header";
import { PageGate } from "@/components/page-gate";
import { Skeleton } from "@/components/ui/skeleton";
import { AuditView } from "@/features/activity/components/audit-view";

export const metadata: Metadata = { title: "Activity" };

function ActivityFallback() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading the audit log</span>
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export default function ActivitySettingsPage() {
  return (
    <>
      <PageHeader
        title="Activity"
        description="Administration changes and every write that Claude Code made with a personal token, newest first."
      />
      <PageGate action="audit.read">
        <Suspense fallback={<ActivityFallback />}>
          <AuditView />
        </Suspense>
      </PageGate>
    </>
  );
}
