import { CircleX, Minus, TriangleAlert, Wallet, type LucideIcon } from "lucide-react";
import { Meter, type MeterTone } from "@/components/meter";
import { StatusBadge } from "@/components/status/status-badge";
import type { Tone } from "@/components/status/tones";
import type { Team } from "@/lib/api/types";
import {
  describeSpend,
  SPEND_STATE_HINTS,
  SPEND_STATE_LABELS,
  spendFractionOf,
  spendStateOf,
  type SpendState,
} from "../labels";

interface SpendPresentation {
  tone: Tone;
  meterTone: MeterTone;
  icon: LucideIcon;
}

const SPEND_PRESENTATION = {
  none: { tone: "hollow", meterTone: "neutral", icon: Minus },
  within: { tone: "hollow", meterTone: "neutral", icon: Wallet },
  reached: { tone: "kpi-warn", meterTone: "warn", icon: TriangleAlert },
  over: { tone: "kpi-bad", meterTone: "bad", icon: CircleX },
} as const satisfies Record<SpendState, SpendPresentation>;

export type SpendBarProps = {
  team: Pick<Team, "name" | "spent_month_usd" | "max_usd_month">;
};

export function SpendBar({ team }: SpendBarProps) {
  const state = spendStateOf(team);
  const presentation = SPEND_PRESENTATION[state];
  const fraction = spendFractionOf(team);
  const summary = describeSpend(team);

  return (
    <div
      data-slot="spend-bar"
      data-spend-state={state}
      className="flex min-w-48 flex-col gap-1.5"
      title={SPEND_STATE_HINTS[state]}
    >
      {fraction === null ? null : (
        <Meter
          value={fraction}
          label={`Spend this month for ${team.name}`}
          valueText={summary}
          tone={presentation.meterTone}
        />
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span data-slot="spend-text" className="tabular-nums">
          {summary}
        </span>
        <StatusBadge
          data-slot="spend-status"
          tone={presentation.tone}
          icon={presentation.icon}
          label={SPEND_STATE_LABELS[state]}
        />
      </div>
    </div>
  );
}
