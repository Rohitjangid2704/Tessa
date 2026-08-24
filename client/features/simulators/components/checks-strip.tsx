import { CircleCheck, CircleHelp, CircleX, Hourglass } from "lucide-react";
import { StatusBadge } from "@/components/status/status-badge";
import { VerdictBadge } from "@/components/status/verdict-badge";
import { cn } from "@/lib/utils";
import { SIM_CHECK_INFO, SIM_CHECKS } from "../schemas";
import type { SimChecks, VerdictStatus } from "../types";

export interface ChecksStripProps {
  checks: SimChecks;
  className?: string;
}

export function ChecksStrip({ checks, className }: ChecksStripProps) {
  return (
    <ul
      data-slot="checks-strip"
      aria-label="The five checks of this session"
      className={cn("flex flex-wrap gap-2", className)}
    >
      {SIM_CHECKS.map((name) => {
        const info = SIM_CHECK_INFO[name];
        return (
          <li
            key={name}
            data-check={name}
            data-status={checks[name]}
            title={info.description}
            className="flex items-center gap-1.5 rounded-lg border px-2 py-1"
          >
            <span className="text-xs font-medium">{info.label}</span>
            <VerdictBadge verdict={checks[name]} />
            {info.decidedBy === "judge" ? (
              <span className="text-xs text-muted-foreground">judge</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export type PassKState = "pending" | "met" | "not_met" | "unconfirmed";

export function passKStateOf(k: number, verdicts: ReadonlyArray<VerdictStatus | null>): PassKState {
  const finished = verdicts.filter((verdict): verdict is VerdictStatus => verdict !== null);
  if (finished.length < k) {
    return "pending";
  }
  if (finished.every((verdict) => verdict === "pass")) {
    return "met";
  }
  return finished.some((verdict) => verdict === "fail" || verdict === "flaky")
    ? "not_met"
    : "unconfirmed";
}

export function passedCountOf(verdicts: ReadonlyArray<VerdictStatus | null>): number {
  return verdicts.filter((verdict) => verdict === "pass").length;
}

export interface PassKStripProps {
  k: number;
  verdicts: ReadonlyArray<VerdictStatus | null>;
  className?: string;
}

function PassKSummary({ k, state }: { k: number; state: PassKState }) {
  switch (state) {
    case "met":
      return <StatusBadge tone="verdict-pass" label={`pass^${k} met`} icon={CircleCheck} />;
    case "not_met":
      return <StatusBadge tone="verdict-fail" label={`pass^${k} not met`} icon={CircleX} />;
    case "unconfirmed":
      return (
        <StatusBadge tone="verdict-uncertain" label={`pass^${k} not confirmed`} icon={CircleHelp} />
      );
    case "pending":
      return <StatusBadge tone="hollow" label={`pass^${k} pending`} icon={Hourglass} />;
  }
}

export function PassKStrip({ k, verdicts, className }: PassKStripProps) {
  const state = passKStateOf(k, verdicts);
  const passed = passedCountOf(verdicts);
  return (
    <div
      data-slot="pass-k-strip"
      data-state={state}
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", className)}
    >
      <PassKSummary k={k} state={state} />
      <ol aria-label={`The ${k} attempts`} className="flex flex-wrap items-center gap-2">
        {Array.from({ length: k }, (_, index) => {
          const verdict = verdicts[index] ?? null;
          return (
            <li key={index} className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground tabular-nums">#{index + 1}</span>
              {verdict === null ? (
                <StatusBadge tone="hollow" label="Pending" icon={Hourglass} />
              ) : (
                <VerdictBadge verdict={verdict} />
              )}
            </li>
          );
        })}
      </ol>
      <span className="text-xs text-muted-foreground">
        {passed} of {k} passed. pass^{k} holds only when every attempt passes.
      </span>
    </div>
  );
}
