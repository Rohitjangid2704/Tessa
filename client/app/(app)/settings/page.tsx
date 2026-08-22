import type { Metadata } from "next";
import { PageHeader } from "@/components/app-shell/page-header";
import { SettingsView } from "@/features/settings/components/settings-view";
import { SettingsDiagnostics } from "@/features/system/components/settings-diagnostics";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Models, thresholds, endpoints, budgets and keys, plus diagnostics for the API and what it depends on."
      />
      <div className="flex max-w-4xl flex-col gap-4">
        <SettingsView />
        <SettingsDiagnostics />
      </div>
    </>
  );
}
