import type { Metadata } from "next";
import { PageHeader } from "@/components/app-shell/page-header";
import { NotificationSettingsView } from "@/features/settings/components/notification-settings-view";

export const metadata: Metadata = { title: "Notification settings" };

export default function NotificationSettingsPage() {
  return (
    <>
      <PageHeader
        title="Notifications"
        description="Where finished scheduled runs are announced: Slack, email and the bell in the header."
      />
      <NotificationSettingsView />
    </>
  );
}
