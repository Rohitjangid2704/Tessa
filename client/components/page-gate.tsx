"use client";

import type { ReactNode } from "react";
import { PermissionDenied } from "@/components/permission-denied";
import { Skeleton } from "@/components/ui/skeleton";
import { useCanDo } from "@/lib/auth/can";
import type { PermissionId } from "@/lib/auth/permissions";

export type PageGateProps = {
  action: PermissionId;
  children: ReactNode;
  pending?: ReactNode;
};

function PageGateSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      data-slot="page-gate-pending"
      className="flex flex-col gap-4"
    >
      <span className="sr-only">Checking your access</span>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

export function PageGate({ action, children, pending }: PageGateProps) {
  const check = useCanDo(action);
  if (check.isPending) {
    return pending ?? <PageGateSkeleton />;
  }
  if (!check.allowed) {
    return <PermissionDenied action={action} />;
  }
  return children;
}
