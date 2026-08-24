"use client";

import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell/app-shell";
import type { ShellUser } from "@/components/app-shell/user-display";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { NotificationBell } from "@/features/notifications/components/bell";
import { ProductionTargetBanner } from "./components/production-target-banner";
import { useCurrentTarget, useRememberCurrentTarget } from "./current-target";
import { TargetSwitcher } from "./target-switcher";

export type TargetAwareShellProps = {
  user: ShellUser;
  defaultOpen?: boolean;
  children: ReactNode;
};

export function TargetAwareShell({ user, defaultOpen, children }: TargetAwareShellProps) {
  const { targetId } = useCurrentTarget();
  useRememberCurrentTarget();
  return (
    <AppShell
      user={user}
      defaultOpen={defaultOpen}
      targetId={targetId}
      headerActions={<TargetSwitcher />}
      headerEnd={<NotificationBell />}
      banner={
        <>
          <ReadOnlyBanner />
          <ProductionTargetBanner />
        </>
      }
    >
      {children}
    </AppShell>
  );
}
