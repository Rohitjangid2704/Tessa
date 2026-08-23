import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface ChipListProps {
  label: string;
  items: readonly string[];
  formatItem?: (item: string) => string;
  renderItem?: (item: string) => ReactNode;
  emptyLabel?: string;
  mono?: boolean;
  showLabel?: boolean;
  className?: string;
}

export function ChipList({
  label,
  items,
  formatItem = (item) => item,
  renderItem,
  emptyLabel,
  mono = true,
  showLabel = true,
  className,
}: ChipListProps) {
  if (items.length === 0 && emptyLabel === undefined) {
    return null;
  }
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1", className)}>
      {showLabel ? <span className="text-xs text-muted-foreground">{label}</span> : null}
      {items.length === 0 ? (
        <span className="text-xs text-muted-foreground">{emptyLabel}</span>
      ) : (
        <ul aria-label={label} className="flex flex-wrap gap-1">
          {items.map((item) => (
            <li key={item}>
              {renderItem === undefined ? (
                <Badge variant="outline" className={mono ? "font-mono" : undefined}>
                  {formatItem(item)}
                </Badge>
              ) : (
                renderItem(item)
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
