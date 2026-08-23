"use client";

import { RefreshCw } from "lucide-react";
import { useId } from "react";
import { LiveIndicator } from "@/components/status/live-indicator";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { describeFeedConnection } from "@/features/runs/feed-connection";
import type { EventStreamState } from "@/lib/sse/stream";
import { PlanPicker } from "./plan-picker";

export interface CoverageToolbarProps {
  targetId: string;
  planId: string | null;
  onPlanChange: (planId: string | null) => void;
  areas: readonly string[];
  area: string | undefined;
  onAreaChange: (area: string | undefined) => void;
  selectionMode: boolean;
  onSelectionModeChange: (mode: boolean) => void;
  stream: EventStreamState;
  onRestartFeed: () => void;
}

const ALL_AREAS = "all";

export function CoverageToolbar({
  targetId,
  planId,
  onPlanChange,
  areas,
  area,
  onAreaChange,
  selectionMode,
  onSelectionModeChange,
  stream,
  onRestartFeed,
}: CoverageToolbarProps) {
  const areaTriggerId = useId();
  const switchId = useId();
  const connection = describeFeedConnection(stream.status);
  const showMessage = stream.status === "reconnecting" || stream.status === "failed";

  return (
    <div data-slot="coverage-toolbar" className="flex flex-wrap items-end gap-x-6 gap-y-3">
      <PlanPicker targetId={targetId} value={planId} onChange={onPlanChange} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={areaTriggerId}>Area</Label>
        <Select
          value={area ?? ALL_AREAS}
          onValueChange={(next) => onAreaChange(next === ALL_AREAS ? undefined : next)}
        >
          <SelectTrigger id={areaTriggerId} className="w-56 max-w-full">
            <SelectValue>{area ?? "All areas"}</SelectValue>
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            <SelectItem value={ALL_AREAS}>All areas</SelectItem>
            {area !== undefined && !areas.includes(area) ? (
              <SelectItem value={area}>{area}</SelectItem>
            ) : null}
            {areas.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2 pb-1.5">
        <Switch
          id={switchId}
          checked={selectionMode}
          onCheckedChange={onSelectionModeChange}
        />
        <Label htmlFor={switchId} className="font-normal">
          Select cells
        </Label>
      </div>
      <div
        data-slot="coverage-feed"
        data-status={stream.status}
        className="ml-auto flex flex-wrap items-center gap-2 pb-1"
      >
        <LiveIndicator state={connection.liveState} label={connection.label} />
        {showMessage && stream.message !== null ? (
          <span className="text-xs text-muted-foreground">{stream.message}</span>
        ) : null}
        {stream.status === "failed" ? (
          <Button type="button" variant="outline" size="sm" onClick={onRestartFeed}>
            <RefreshCw aria-hidden="true" data-icon="inline-start" />
            Retry live updates
          </Button>
        ) : null}
      </div>
    </div>
  );
}
