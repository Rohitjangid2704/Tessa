"use client";

import { Ellipsis } from "lucide-react";
import { RequiresPermission } from "@/components/requires-permission";
import { findingStatusPresentation } from "@/components/status/finding-status-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { FindingStatus, FindingSummary } from "@/lib/api/types";
import { useCanDo } from "@/lib/auth/can";
import { FINDING_STATUS_LABELS, moveLabel, USER_TRANSITIONS } from "../detail-schemas";

export interface MoveMenuProps {
  finding: FindingSummary;
  disabled?: boolean;
  onMove: (finding: FindingSummary, to: FindingStatus) => void;
}

export function moveTargets(from: FindingStatus): readonly FindingStatus[] {
  return USER_TRANSITIONS[from].filter((status) => status !== "resolved");
}

export function MoveMenu({ finding, disabled = false, onMove }: MoveMenuProps) {
  const access = useCanDo("findings.update");
  const targets = moveTargets(finding.status);
  const label = `Move finding: ${finding.title}`;

  if (!access.allowed) {
    return (
      <RequiresPermission action="findings.update">
        {() => (
          <Button type="button" variant="ghost" size="icon-sm" disabled aria-label={label}>
            <Ellipsis aria-hidden="true" />
          </Button>
        )}
      </RequiresPermission>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          aria-label={label}
          data-slot="move-menu-trigger"
        >
          <Ellipsis aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuLabel>
          Move from {FINDING_STATUS_LABELS[finding.status]} to
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {targets.map((status) => {
          const { icon: Icon } = findingStatusPresentation[status];
          return (
            <DropdownMenuItem key={status} onSelect={() => onMove(finding, status)}>
              <Icon aria-hidden="true" />
              {moveLabel(finding.status, status)}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
