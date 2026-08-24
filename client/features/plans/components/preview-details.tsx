"use client";

import { CircleSlash, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  describeSkippedItem,
  groupSkipped,
  PLAN_SKIP_REASON_TEXT,
  type SkippedGroup,
} from "../skip-reasons";
import type { PlanSkippedItem } from "../types";

const CONTENT_CLASS = "max-h-96 w-[26rem] max-w-[calc(100vw-2rem)] overflow-y-auto";

function SkippedGroupList({ group }: { group: SkippedGroup }) {
  const text = PLAN_SKIP_REASON_TEXT[group.reason];
  return (
    <section
      data-reason={group.reason}
      aria-label={`${text.label}, ${group.items.length} skipped`}
      className="flex flex-col gap-1"
    >
      <h3 className="text-sm font-medium">
        {text.label}{" "}
        <span className="font-normal text-muted-foreground">({group.items.length})</span>
      </h3>
      <p className="text-xs text-muted-foreground">{text.description}</p>
      <ul className="flex flex-col gap-0.5">
        {group.items.map((item, index) => {
          const label = describeSkippedItem(item);
          return (
            <li key={`${label}-${index}`} className="font-mono text-xs break-all">
              {label}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function SkippedPopover({ skipped }: { skipped: readonly PlanSkippedItem[] }) {
  if (skipped.length === 0) {
    return null;
  }
  const groups = groupSkipped(skipped);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" data-slot="skipped-trigger">
          <CircleSlash aria-hidden="true" data-icon="inline-start" />
          {skipped.length} skipped
          <span className="sr-only">, show the reasons</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="Skipped cells" className={CONTENT_CLASS}>
        <PopoverHeader>
          <PopoverTitle>Skipped in this plan</PopoverTitle>
          <PopoverDescription>
            These features will not run as selected. The run lists them as skipped with the same
            reason.
          </PopoverDescription>
        </PopoverHeader>
        {groups.map((group) => (
          <SkippedGroupList key={group.reason} group={group} />
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function WarningsPopover({ warnings }: { warnings: readonly string[] }) {
  if (warnings.length === 0) {
    return null;
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" data-slot="warnings-trigger">
          <TriangleAlert aria-hidden="true" data-icon="inline-start" />
          {warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`}
          <span className="sr-only">, show them</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="Plan warnings" className={CONTENT_CLASS}>
        <PopoverHeader>
          <PopoverTitle>Warnings about this plan</PopoverTitle>
        </PopoverHeader>
        <ul className="flex list-disc flex-col gap-1.5 pl-4 text-sm">
          {warnings.map((warning, index) => (
            <li key={`${warning}-${index}`}>{warning}</li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
