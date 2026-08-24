import { Clock, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import type { CostPercentiles, LatencyPercentiles } from "@/lib/api/types";
import { formatUsd } from "@/lib/format-usd";
import { cn } from "@/lib/utils";
import { formatMilliseconds } from "../format";

type TileProps = {
  label: string;
  value: ReactNode;
  emphasis?: boolean;
};

function Tile({ label, value, emphasis = false }: TileProps) {
  return (
    <div
      data-slot="percentile-tile"
      className="flex min-w-0 flex-col gap-1 rounded-lg border bg-card px-3 py-2"
    >
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("text-lg tabular-nums", emphasis ? "font-semibold" : "font-medium")}>
        {value}
      </dd>
    </div>
  );
}

export type PercentileTilesProps = {
  latency: LatencyPercentiles;
  cost: CostPercentiles;
};

export function PercentileTiles({ latency, cost }: PercentileTilesProps) {
  return (
    <div data-slot="percentile-tiles" className="grid gap-4 md:grid-cols-2">
      <section aria-labelledby="latency-heading" className="flex flex-col gap-2">
        <h3 id="latency-heading" className="flex items-center gap-1.5 text-sm font-semibold">
          <Clock aria-hidden="true" className="size-4 text-muted-foreground" />
          Latency per step
        </h3>
        <dl className="grid grid-cols-3 gap-2">
          <Tile label="p50" value={formatMilliseconds(latency.p50)} />
          <Tile label="p90" value={formatMilliseconds(latency.p90)} />
          <Tile label="p99" value={formatMilliseconds(latency.p99)} />
        </dl>
      </section>
      <section aria-labelledby="cost-heading" className="flex flex-col gap-2">
        <h3 id="cost-heading" className="flex items-center gap-1.5 text-sm font-semibold">
          <Wallet aria-hidden="true" className="size-4 text-muted-foreground" />
          Cost
        </h3>
        <dl className="grid grid-cols-3 gap-2">
          <Tile label="Total" value={formatUsd(cost.total)} emphasis />
          <Tile label="p50 per scenario" value={formatUsd(cost.p50)} />
          <Tile label="p90 per scenario" value={formatUsd(cost.p90)} />
        </dl>
      </section>
    </div>
  );
}
