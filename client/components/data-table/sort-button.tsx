import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type SortDirectionState = false | "asc" | "desc";

export interface SortButtonProps {
  label?: string;
  direction: SortDirectionState;
  onToggle: () => void;
  align?: "start" | "center" | "end";
  children: ReactNode;
}

const ICON_BY_DIRECTION = { asc: ArrowUp, desc: ArrowDown } as const;

export function sortAriaValue(direction: SortDirectionState): "ascending" | "descending" | "none" {
  if (direction === "asc") {
    return "ascending";
  }
  return direction === "desc" ? "descending" : "none";
}

export function SortButton({
  label,
  direction,
  onToggle,
  align = "start",
  children,
}: SortButtonProps) {
  const Icon = direction === false ? ChevronsUpDown : ICON_BY_DIRECTION[direction];
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={label === undefined ? undefined : `Sort by ${label}`}
      data-sort-direction={direction === false ? "none" : direction}
      className={cn("-mx-2 font-medium", align === "end" && "flex-row-reverse")}
      onClick={onToggle}
    >
      {children}
      <Icon
        aria-hidden="true"
        className={cn("size-3.5", direction === false && "text-muted-foreground")}
      />
    </Button>
  );
}
