import type { Metadata } from "next";
import { PageHeader } from "@/components/app-shell/page-header";
import { PageGate } from "@/components/page-gate";
import { RetentionView } from "@/features/retention/components/retention-view";

export const metadata: Metadata = { title: "Retention settings" };

export default function RetentionSettingsPage() {
  return (
    <>
      <PageHeader
        title="Retention"
        description="How long step payloads, recordings and run events are kept before a scheduled sweep deletes them."
      />
      <PageGate action="retention.write">
        <RetentionView />
      </PageGate>
    </>
  );
}
