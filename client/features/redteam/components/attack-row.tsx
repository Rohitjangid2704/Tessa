"use client";

import { ChevronDown, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { Attack } from "@/lib/api/types";
import { findingRoutes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { CONTENT_WARNING, skepticStateOf } from "../labels";
import { AttackOutcomeBadge, SkepticBadge } from "./attack-badges";

export type AttackRowProps = {
  attack: Attack;
  familyTitle: string;
  roundLabel: string | null;
};

type TextBlockProps = {
  title: string;
  text: string;
};

function TextBlock({ title, text }: TextBlockProps) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col gap-1">
      <h4 id={titleId} className="text-xs font-semibold text-muted-foreground">
        {title}
      </h4>
      <pre
        data-slot="attack-text"
        className="max-h-56 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs wrap-break-word whitespace-pre-wrap"
      >
        {text === "" ? "(empty)" : text}
      </pre>
    </section>
  );
}

export function AttackRow({ attack, familyTitle, roundLabel }: AttackRowProps) {
  const [open, setOpen] = useState(false);
  const state = skepticStateOf(attack.outcome, attack.skeptic_verdict);
  const reason = attack.skeptic_verdict?.reason ?? null;

  return (
    <li
      data-slot="attack-row"
      data-attack-id={attack.id}
      data-outcome={attack.outcome}
      data-skeptic={state}
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3",
        attack.outcome === "breached" && "border-attack-breached-fg/40",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{familyTitle}</span>
        {roundLabel === null ? null : (
          <span className="text-xs text-muted-foreground">{roundLabel}</span>
        )}
        <AttackOutcomeBadge outcome={attack.outcome} />
        {attack.outcome === "blocked" ? null : <SkepticBadge state={state} />}
        {attack.finding_id === null ? null : (
          <Link
            href={findingRoutes.detail(attack.finding_id)}
            className="text-sm underline underline-offset-4"
          >
            Open the finding
          </Link>
        )}
      </div>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="-ml-2 w-fit">
            <ChevronDown
              aria-hidden="true"
              data-icon="inline-start"
              className={cn("transition-transform motion-reduce:transition-none", open && "rotate-180")}
            />
            {open ? "Hide the attack text" : "Show the attack text"}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 flex flex-col gap-3">
          <p
            role="note"
            data-slot="content-warning"
            className="flex items-start gap-2 text-xs text-muted-foreground"
          >
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            {CONTENT_WARNING}
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            <TextBlock title="Attack prompt (excerpt)" text={attack.prompt_excerpt} />
            <TextBlock title="Reply from the target (excerpt)" text={attack.response_excerpt} />
          </div>
          {reason === null ? null : <TextBlock title="Skeptic reasoning" text={reason} />}
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
