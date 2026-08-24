"use client";

import type { ReactNode } from "react";
import { TargetRequired, type TargetRequiredProps } from "@/components/states/target-required";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentTarget } from "./current-target";

export type CurrentTargetGateProps = Pick<TargetRequiredProps, "title" | "description"> & {
  children: (targetId: string) => ReactNode;
};

export function CurrentTargetGate({ children, title, description }: CurrentTargetGateProps) {
  const { targetId, isResolved } = useCurrentTarget();
  if (targetId !== null) {
    return children(targetId);
  }
  if (!isResolved) {
    return (
      <div role="status" aria-busy="true">
        <span className="sr-only">Loading the current target</span>
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  return <TargetRequired title={title} description={description} />;
}
