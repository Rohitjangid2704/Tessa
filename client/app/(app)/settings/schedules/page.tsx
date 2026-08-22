import type { Metadata } from "next";
import { PageHeader } from "@/components/app-shell/page-header";
import { SchedulesSettingsView } from "@/features/settings/components/schedules-settings-view";

export const metadata: Metadata = { title: "Schedule settings" };

export default function ScheduleSettingsPage() {
  return (
    <>
      <PageHeader
        title="Schedules"
        description="Nightly, weekly and commit schedules across all targets, and the flakiness policy that applies to their runs."
      />
      <SchedulesSettingsView />
    </>
  );
}
