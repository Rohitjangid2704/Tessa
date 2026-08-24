import { TierBadge } from "@/components/status/tier-badge";
import { VERDICT_TIERS } from "@/components/status/status-types";
import type { TierMix } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { formatCount, formatPercent } from "../results-format";

const SEGMENT_CLASSES = {
  code: "bg-tier-code-fg",
  laya: "bg-tier-laya-fg",
  judge: "bg-tier-judge-fg",
  human: "bg-tier-human-fg",
} as const;

export type TierMixBarProps = {
  tiers: TierMix;
  className?: string;
};

export function totalOfTiers(tiers: TierMix): number {
  return VERDICT_TIERS.reduce((sum, tier) => sum + tiers[tier], 0);
}

export function TierMixBar({ tiers, className }: TierMixBarProps) {
  const total = totalOfTiers(tiers);
  return (
    <section
      aria-labelledby="tier-mix-heading"
      data-slot="tier-mix"
      className={cn("flex flex-col gap-3", className)}
    >
      <h3 id="tier-mix-heading" className="text-sm font-semibold">
        Verdict tiers
      </h3>
      {total === 0 ? (
        <p className="text-sm text-muted-foreground">No verdicts have been decided yet.</p>
      ) : (
        <>
          <div
            aria-hidden="true"
            data-slot="tier-mix-bar"
            className="flex h-3 w-full overflow-hidden rounded-full bg-muted"
          >
            {VERDICT_TIERS.filter((tier) => tiers[tier] > 0).map((tier) => (
              <div
                key={tier}
                data-tier={tier}
                className={cn("h-full border-r border-card last:border-r-0", SEGMENT_CLASSES[tier])}
                style={{ width: `${(tiers[tier] / total) * 100}%` }}
              />
            ))}
          </div>
          <ul className="flex flex-wrap gap-x-5 gap-y-2" aria-label="Verdicts by tier">
            {VERDICT_TIERS.map((tier) => (
              <li
                key={tier}
                data-slot="tier-mix-item"
                data-tier={tier}
                className="flex items-center gap-2 text-sm tabular-nums"
              >
                <TierBadge tier={tier} />
                <span className="font-medium">{formatCount(tiers[tier])}</span>
                <span className="text-muted-foreground">{formatPercent(tiers[tier] / total)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
