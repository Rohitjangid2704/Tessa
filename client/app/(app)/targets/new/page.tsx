import type { Metadata } from "next";
import { PageHeader } from "@/components/app-shell/page-header";
import { NewTargetWizard } from "@/features/targets/components/new-target-wizard";

export const metadata: Metadata = { title: "New target" };

export default function NewTargetPage() {
  return (
    <>
      <PageHeader
        title="New target"
        description="Name the app, then copy its Discovery prompt into Claude Code."
      />
      <NewTargetWizard />
    </>
  );
}
