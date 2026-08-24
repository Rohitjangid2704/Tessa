import { Meter } from "@/components/meter";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { FamilyStats } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { formatCount, formatPercent } from "../results-format";

export type FamilyPasskTableProps = {
  families: readonly FamilyStats[];
  k: number;
};

export function hasFinishedScenarios(family: FamilyStats): boolean {
  return family.scenarios > family.skipped;
}

function CountCell({
  count,
  kind,
}: {
  count: number;
  kind: "flaky" | "uncertain" | "skipped";
}) {
  return (
    <TableCell
      data-count={count}
      data-kind={kind}
      className={cn("text-right tabular-nums", count === 0 && "text-muted-foreground")}
    >
      {count > 0 && kind === "uncertain" ? (
        <span className="hatched inline-block min-w-6 rounded-md bg-verdict-flaky-bg px-1.5 font-medium text-verdict-flaky-fg">
          {formatCount(count)}
        </span>
      ) : (
        formatCount(count)
      )}
    </TableCell>
  );
}

export function FamilyPasskTable({ families, k }: FamilyPasskTableProps) {
  return (
    <Table data-slot="family-passk-table">
      <TableCaption className="text-left">
        pass^{k} is the share of finished scenarios where all {k} {k === 1 ? "attempt" : "attempts"}{" "}
        passed. Flaky, uncertain and skipped scenarios are counted on their own and never folded
        into pass or fail.
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Family</TableHead>
          <TableHead scope="col" className="text-right">
            Scenarios
          </TableHead>
          <TableHead scope="col" className="min-w-44">
            pass^{k}
          </TableHead>
          <TableHead scope="col" className="text-right">
            Flaky
          </TableHead>
          <TableHead scope="col" className="text-right">
            Uncertain
          </TableHead>
          <TableHead scope="col" className="text-right">
            Skipped
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {families.map((family) => {
          const finished = hasFinishedScenarios(family);
          return (
            <TableRow key={family.family} data-family={family.family}>
              <TableCell className="font-medium wrap-break-word">{family.family}</TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCount(family.scenarios)}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-3">
                  <span className="w-12 shrink-0 text-right font-medium tabular-nums">
                    {finished ? formatPercent(family.pass_hat_k) : "n/a"}
                  </span>
                  <Meter
                    value={finished ? family.pass_hat_k : null}
                    label={`pass^${k} of ${family.family}`}
                    valueText={
                      finished ? formatPercent(family.pass_hat_k) : "No finished scenarios"
                    }
                  />
                </div>
              </TableCell>
              <CountCell count={family.flaky} kind="flaky" />
              <CountCell count={family.uncertain} kind="uncertain" />
              <CountCell count={family.skipped} kind="skipped" />
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
