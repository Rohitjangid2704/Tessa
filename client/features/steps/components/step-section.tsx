import { Info, TriangleAlert } from "lucide-react";
import { Fragment, useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface StepSectionProps {
  title: string;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function StepSection({ title, actions, className, children }: StepSectionProps) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-slot="step-section"
      className={cn("flex min-w-0 flex-col gap-3", className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-1.5">
        <h3 id={headingId} className="text-sm font-semibold">
          {title}
        </h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Subsection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div data-slot="step-subsection" className="flex min-w-0 flex-col gap-1.5">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      {children}
    </div>
  );
}

export interface StepNoticeProps {
  tone: "info" | "warning";
  title: string;
  children: ReactNode;
}

export function StepNotice({ tone, title, children }: StepNoticeProps) {
  const Icon = tone === "warning" ? TriangleAlert : Info;
  return (
    <div
      role="note"
      data-slot="step-notice"
      data-tone={tone}
      className="flex items-start gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-sm text-foreground"
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="font-medium">{title}</p>
        <p>{children}</p>
      </div>
    </div>
  );
}

export interface EmptyNoteProps {
  children: ReactNode;
  compact?: boolean;
}

export function EmptyNote({ children, compact = false }: EmptyNoteProps) {
  return (
    <p
      data-slot="empty-note"
      className={
        compact
          ? "text-sm text-muted-foreground"
          : "rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground"
      }
    >
      {children}
    </p>
  );
}

export interface Fact {
  label: string;
  value: ReactNode;
  mono?: boolean;
}

export interface FactListProps {
  facts: readonly Fact[];
  keys?: "text" | "code";
  className?: string;
}

export function FactList({ facts, keys = "text", className }: FactListProps) {
  return (
    <dl
      data-slot="fact-list"
      className={cn(
        "grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm",
        className,
      )}
    >
      {facts.map((fact) => (
        <Fragment key={fact.label}>
          <dt
            className={cn(
              "text-muted-foreground",
              keys === "code" && "font-mono text-xs text-foreground",
            )}
          >
            {fact.label}
          </dt>
          <dd className={cn("wrap-anywhere min-w-0", fact.mono === true && "font-mono text-xs")}>
            {fact.value}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}
