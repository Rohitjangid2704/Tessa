import type { ReactNode } from "react";
import { SettingsSubnav } from "@/features/settings/components/settings-subnav";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <SettingsSubnav />
      <div>{children}</div>
    </div>
  );
}
