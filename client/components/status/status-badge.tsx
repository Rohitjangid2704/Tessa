import type { LucideIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { toneClasses, type Tone } from "./tones";

export type StatusBadgeProps = Omit<ComponentProps<"span">, "children"> & {
  tone: Tone;
  label: string;
  icon: LucideIcon;
};

export function StatusBadge({ tone, label, icon: Icon, className, ...props }: StatusBadgeProps) {
  return (
    <span
      data-slot="status-badge"
      data-tone={tone}
      className={cn(
        "inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-4xl border px-2 text-xs font-medium whitespace-nowrap",
        toneClasses[tone],
        className,
      )}
      {...props}
    >
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      {label}
    </span>
  );
}
