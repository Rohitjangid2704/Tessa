"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCanDo } from "@/lib/auth/can";
import { HELLO_LIMITS, type HelloRunInput } from "./mutations";

export const VIEWER_START_HINT = "Starting a run needs the member role. Your role is viewer.";

export function clampInteger(
  value: number,
  limits: { min: number; max: number; fallback: number },
): number {
  if (!Number.isFinite(value)) {
    return limits.fallback;
  }
  return Math.min(limits.max, Math.max(limits.min, Math.trunc(value)));
}

function NumberField({
  id,
  label,
  limits,
  value,
  step,
  className,
  onCommit,
}: {
  id: string;
  label: string;
  limits: { min: number; max: number; fallback: number };
  value: number;
  step?: number;
  className: string;
  onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={limits.min}
        max={limits.max}
        step={step}
        value={draft ?? String(value)}
        className={className}
        onChange={(event) => {
          setDraft(event.target.value);
          if (Number.isFinite(event.target.valueAsNumber)) {
            onCommit(clampInteger(event.target.valueAsNumber, limits));
          }
        }}
        onBlur={() => setDraft(null)}
      />
    </div>
  );
}

export const DEFAULT_HELLO_INPUT: HelloRunInput = {
  ticks: HELLO_LIMITS.ticks.fallback,
  tick_interval_ms: HELLO_LIMITS.tickIntervalMs.fallback,
  include_laya: true,
};

export function HelloControls({
  value,
  onChange,
  onSubmit,
  pending,
}: {
  value: HelloRunInput;
  onChange: (next: HelloRunInput) => void;
  onSubmit: (input: HelloRunInput) => void;
  pending: boolean;
}) {
  const ticksId = useId();
  const intervalId = useId();
  const layaId = useId();
  const hintId = useId();
  const { allowed, isPending: rolePending } = useCanDo("system.hello_run");
  const blockedForRole = !rolePending && !allowed;
  const disabled = pending || rolePending || !allowed;

  return (
    <form
      aria-label="Hello run settings"
      className="flex flex-wrap items-end gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) {
          onSubmit(value);
        }
      }}
    >
      <NumberField
        id={ticksId}
        label="Ticks"
        limits={HELLO_LIMITS.ticks}
        value={value.ticks}
        className="w-24"
        onCommit={(ticks) => onChange({ ...value, ticks })}
      />
      <NumberField
        id={intervalId}
        label="Interval (ms)"
        limits={HELLO_LIMITS.tickIntervalMs}
        step={100}
        value={value.tick_interval_ms}
        className="w-32"
        onCommit={(tickIntervalMs) => onChange({ ...value, tick_interval_ms: tickIntervalMs })}
      />
      <div className="flex items-center gap-2 pb-1.5">
        <Switch
          id={layaId}
          checked={value.include_laya}
          onCheckedChange={(checked) => onChange({ ...value, include_laya: checked })}
        />
        <Label htmlFor={layaId}>Include Laya</Label>
      </div>
      <div className="flex flex-col gap-1">
        {blockedForRole ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="inline-flex rounded-lg" aria-describedby={hintId}>
                <Button type="submit" disabled aria-describedby={hintId}>
                  Start hello run
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{VIEWER_START_HINT}</TooltipContent>
          </Tooltip>
        ) : (
          <Button type="submit" disabled={disabled}>
            {pending ? "Starting..." : "Start hello run"}
          </Button>
        )}
        {blockedForRole ? (
          <p id={hintId} className="max-w-64 text-xs text-muted-foreground">
            {VIEWER_START_HINT}
          </p>
        ) : null}
      </div>
    </form>
  );
}
