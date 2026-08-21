import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import type { LiveState } from "./status-types";
import { toneClasses, type Tone } from "./tones";

const livePresentation = {
  live: { tone: "live-live", label: "Live", pulse: true },
  reconnecting: { tone: "live-reconnecting", label: "Reconnecting", pulse: false },
  closed: { tone: "live-closed", label: "Closed", pulse: false },
  error: { tone: "live-error", label: "Error", pulse: false },
} as const satisfies Record<LiveState, { tone: Tone; label: string; pulse: boolean }>;

export function LiveIndicator({
  state,
  label: labelOverride,
  className,
  ...props
}: { state: LiveState; label?: string } & Omit<ComponentProps<"span">, "children">) {
  const { tone, label: defaultLabel, pulse } = livePresentation[state];
  const label = labelOverride ?? defaultLabel;
  return (
    <span
      role="status"
      data-slot="live-indicator"
      data-state={state}
      className={cn(
        "inline-flex h-5 w-fit shrink-0 items-center gap-1.5 rounded-4xl border px-2 text-xs font-medium whitespace-nowrap",
        toneClasses[tone],
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn("size-2 rounded-full bg-current", pulse && "motion-safe:animate-pulse")}
      />
      {label}
    </span>
  );
}
