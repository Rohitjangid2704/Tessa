"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Circle, CircleCheck } from "lucide-react";
import Link from "next/link";
import { useId, type ReactNode } from "react";
import { promptIssuesQuery } from "@/features/prompts/queries";
import { targetRoutes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { hasDeployedMutant, hasMeasuredMutant } from "../model";
import { MUTANTS_FILE_PATH } from "../schemas";
import type { Mutant } from "../types";

export type WorkflowChecklistProps = {
  targetId: string;
  mutants: readonly Mutant[] | null;
  className?: string;
};

interface WorkflowStep {
  id: string;
  title: string;
  detail: ReactNode;
  done: boolean;
}

const LATEST_ISSUE_ONLY = 1;

export function WorkflowChecklist({ targetId, mutants, className }: WorkflowChecklistProps) {
  const headingId = useId();
  const issued = useInfiniteQuery(promptIssuesQuery(targetId, "mutants", LATEST_ISSUE_ONLY));
  const loading = mutants === null;
  const registered = mutants ?? [];
  const hasMutants = registered.length > 0;
  const promptIssued = (issued.data?.items.length ?? 0) > 0;

  const steps: WorkflowStep[] = [
    {
      id: "prompt",
      title: "Copy the Mutants prompt",
      detail: "Pick the invariants to break in the Mutants prompt card and copy the text.",
      done: promptIssued || hasMutants,
    },
    {
      id: "branches",
      title: "Claude Code makes one branch per bug",
      detail: `Paste the prompt into Claude Code in the repository. It creates the branches and writes ${MUTANTS_FILE_PATH}.`,
      done: hasMutants,
    },
    {
      id: "deploy",
      title: "Deploy each branch to QA",
      detail: "Serve every branch as its own copy of the app on a QA URL.",
      done: hasDeployedMutant(registered),
    },
    {
      id: "register",
      title: "Register the mutants",
      detail: (
        <>
          Use Register a mutant below, or{" "}
          <Link href={targetRoutes.bundles(targetId)} className="underline underline-offset-3">
            upload the bundle again
          </Link>{" "}
          with {MUTANTS_FILE_PATH}.
        </>
      ),
      done: hasMutants,
    },
    {
      id: "run",
      title: "Run each mutant",
      detail: "Press Run on a deployed mutant. The suite power updates when its run finishes.",
      done: hasMeasuredMutant(registered),
    },
  ];
  const currentId = loading ? null : (steps.find((step) => !step.done)?.id ?? null);

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={loading}
      data-slot="workflow-checklist"
      className={cn("flex flex-col gap-3 rounded-xl border p-4", className)}
    >
      <h2 id={headingId} className="text-base font-semibold">
        How to measure the suite
      </h2>
      <ol className="flex flex-col gap-3">
        {steps.map((step) => (
          <li
            key={step.id}
            data-step={step.id}
            data-done={step.done}
            aria-current={step.id === currentId ? "step" : undefined}
            className="flex items-start gap-2 text-sm"
          >
            {step.done ? (
              <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-kpi-good-fg" />
            ) : (
              <Circle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="flex min-w-0 flex-col">
              <span className="font-medium">
                {step.title}
                <span className="sr-only">{step.done ? ", done" : ", not done yet"}</span>
              </span>
              <span className="text-muted-foreground">{step.detail}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
