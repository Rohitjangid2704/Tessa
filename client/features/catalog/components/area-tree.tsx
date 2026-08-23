"use client";

import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { areaSelectionState, type CatalogSelection } from "../selection";
import type { AdapterKind, CatalogArea } from "../types";
import { FeatureCard } from "./feature-card";

export interface AreaTreeProps {
  areas: readonly CatalogArea[];
  totals?: ReadonlyMap<string, number>;
  selection?: CatalogSelection;
  interfaceKinds?: ReadonlyMap<string, AdapterKind>;
  label?: string;
  defaultOpen?: boolean;
}

function describeCount(shown: number, total: number | undefined): string {
  if (total !== undefined && total !== shown) {
    return `${shown} of ${total} features`;
  }
  return `${shown} ${shown === 1 ? "feature" : "features"}`;
}

interface AreaNodeProps {
  area: CatalogArea;
  total: number | undefined;
  selection: CatalogSelection | undefined;
  interfaceKinds: ReadonlyMap<string, AdapterKind> | undefined;
  defaultOpen: boolean;
}

function AreaNode({ area, total, selection, interfaceKinds, defaultOpen }: AreaNodeProps) {
  const [open, setOpen] = useState(defaultOpen);
  const state = selection === undefined ? "none" : areaSelectionState(area, selection.isSelected);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-slot="area-node"
      data-area={area.name}
      className="flex flex-col gap-3"
    >
      <div className="flex items-center gap-2">
        {selection === undefined ? null : (
          <Checkbox
            aria-label={`Select every feature in ${area.name}`}
            checked={state === "all" ? true : state === "some" ? "indeterminate" : false}
            onCheckedChange={(checked) => selection.onToggleArea(area, checked === true)}
          />
        )}
        <h2 className="min-w-0 text-base font-semibold">
          <CollapsibleTrigger className="group/area flex items-center gap-2 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            <ChevronRight
              aria-hidden="true"
              className="size-4 shrink-0 transition-transform group-data-[state=open]/area:rotate-90"
            />
            <span className="break-words">{area.name}</span>{" "}
            <Badge variant="secondary">{describeCount(area.items.length, total)}</Badge>
          </CollapsibleTrigger>
        </h2>
      </div>
      <CollapsibleContent>
        <ul aria-label={`Features in ${area.name}`} className="flex flex-col gap-3">
          {area.items.map((item) => (
            <li key={item.id}>
              <FeatureCard
                item={item}
                interfaceKinds={interfaceKinds}
                selected={selection?.isSelected(item.id)}
                onSelectedChange={
                  selection === undefined
                    ? undefined
                    : (selected) => selection.onToggleItem(item, selected)
                }
              />
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function AreaTree({
  areas,
  totals,
  selection,
  interfaceKinds,
  label = "Feature areas",
  defaultOpen = true,
}: AreaTreeProps) {
  return (
    <ul aria-label={label} data-slot="area-tree" className="flex flex-col gap-8">
      {areas.map((area) => (
        <li key={area.name}>
          <AreaNode
            area={area}
            total={totals?.get(area.name)}
            selection={selection}
            interfaceKinds={interfaceKinds}
            defaultOpen={defaultOpen}
          />
        </li>
      ))}
    </ul>
  );
}
