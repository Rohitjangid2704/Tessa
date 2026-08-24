"use client";

import { Flag } from "lucide-react";
import { useState } from "react";
import { RoleGate } from "@/components/role-gate";
import { Button } from "@/components/ui/button";
import { LabelDialog, OwnLabelChip } from "@/features/labels";
import type { LabelSubjectType, Step } from "@/lib/api/types";
import { cn } from "@/lib/utils";

export type LabelFlowProps = {
  step: Pick<Step, "id" | "run_id">;
  subjectType: LabelSubjectType;
  subjectId: string;
  actionLabel?: string | null;
  className?: string;
};

function LabelFlowControls({
  step,
  subjectType,
  subjectId,
  actionLabel,
  className,
}: LabelFlowProps) {
  const [open, setOpen] = useState(false);

  return (
    <div
      data-slot="label-flow"
      data-subject-type={subjectType}
      className={cn("flex flex-wrap items-center gap-2", className)}
    >
      {actionLabel === null || actionLabel === undefined ? null : (
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Flag aria-hidden="true" data-icon="inline-start" />
          {actionLabel}
        </Button>
      )}
      <OwnLabelChip
        subjectType={subjectType}
        subjectId={subjectId}
        stepId={step.id}
        runId={step.run_id}
      />
      <LabelDialog
        subjectType={subjectType}
        subjectId={subjectId}
        stepId={step.id}
        runId={step.run_id}
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  );
}

export function LabelFlow(props: LabelFlowProps) {
  return (
    <RoleGate action="labels.create">
      <LabelFlowControls {...props} />
    </RoleGate>
  );
}
