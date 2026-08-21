"use client";

import { Eye } from "lucide-react";
import { useCurrentRole } from "@/lib/auth/can";

export function ReadOnlyBanner() {
  const { role, isPending } = useCurrentRole();
  if (isPending || role !== "viewer") {
    return null;
  }
  return (
    <div
      role="status"
      data-slot="read-only-banner"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted px-4 py-1.5 text-sm text-foreground"
    >
      <Eye aria-hidden="true" className="size-4 shrink-0" />
      <span className="font-medium">Read-only access</span>
      <span>You are signed in as a viewer. Ask an admin for the member role to change data.</span>
    </div>
  );
}
