import type { Metadata } from "next";
import { PageHeader } from "@/components/app-shell/page-header";
import { TeamsView } from "@/features/teams/components/teams-view";

export const metadata: Metadata = { title: "Team settings" };

export default function TeamSettingsPage() {
  return (
    <>
      <PageHeader
        title="Teams"
        description="Monthly budgets and ownership for groups of targets, and who belongs to each team."
      />
      <TeamsView />
    </>
  );
}
