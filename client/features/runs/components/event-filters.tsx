"use client";

import { Check } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  EVENT_FAMILY_LABELS,
  listedFamilies,
  type EventFamily,
  type FamilyCounts,
} from "../event-log-model";

export type EventFiltersProps = {
  counts: FamilyCounts;
  selected: ReadonlySet<EventFamily>;
  onToggleFamily: (family: EventFamily) => void;
  onClear: () => void;
  showStream: boolean;
  onShowStreamChange: (show: boolean) => void;
  streamCount: number;
};

export function EventFilters({
  counts,
  selected,
  onToggleFamily,
  onClear,
  showStream,
  onShowStreamChange,
  streamCount,
}: EventFiltersProps) {
  const switchId = useId();
  const families = listedFamilies(counts, selected);

  return (
    <div data-slot="event-filters" className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div
        role="group"
        aria-label="Filter events by type"
        className="flex flex-wrap items-center gap-1.5"
      >
        {families.map((family) => {
          const pressed = selected.has(family);
          return (
            <Button
              key={family}
              type="button"
              size="xs"
              variant={pressed ? "default" : "outline"}
              aria-pressed={pressed}
              data-family={family}
              onClick={() => onToggleFamily(family)}
            >
              {pressed ? <Check aria-hidden="true" data-icon="inline-start" /> : null}
              {EVENT_FAMILY_LABELS[family]}
              <span className="tabular-nums">{counts[family]}</span>
            </Button>
          );
        })}
        {selected.size > 0 ? (
          <Button type="button" size="xs" variant="ghost" onClick={onClear}>
            Clear filters
          </Button>
        ) : null}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Switch
          id={switchId}
          size="sm"
          checked={showStream}
          onCheckedChange={onShowStreamChange}
        />
        <Label htmlFor={switchId} className="text-xs font-normal">
          Stream events (debug)
          <span className="tabular-nums text-muted-foreground">{streamCount}</span>
        </Label>
      </div>
    </div>
  );
}
