"use client";

import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { targetRoutes } from "@/lib/routes";
import type { RunStartProblem } from "../run-errors";

export interface RunStartAlertProps {
  problem: RunStartProblem;
  error: unknown;
  targetId: string;
}

function NameList({ label, names }: { label: string; names: readonly string[] }) {
  return (
    <div className="mt-2">
      <p className="font-medium text-foreground">{label}</p>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {names.map((name) => (
          <li
            key={name}
            className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground"
          >
            {name}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProblemActions({ problem, targetId }: Pick<RunStartAlertProps, "problem" | "targetId">) {
  if (problem.kind === "production_blocked") {
    return (
      <Button asChild variant="outline" size="sm" className="mt-3">
        <Link href={targetRoutes.detail(targetId)}>Open the target</Link>
      </Button>
    );
  }
  if (problem.kind !== "target_not_ready") {
    return null;
  }
  const needsEnvironment =
    problem.missingEnvironment.length > 0 || problem.missingInterfaces.length > 0;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {needsEnvironment ? (
        <Button asChild variant="outline" size="sm">
          <Link href={targetRoutes.environment(targetId)}>Open Environment</Link>
        </Button>
      ) : null}
      {problem.bundleMissing ? (
        <Button asChild variant="outline" size="sm">
          <Link href={targetRoutes.bundles(targetId)}>Upload a bundle</Link>
        </Button>
      ) : null}
    </div>
  );
}

export function RunStartAlert({ problem, error, targetId }: RunStartAlertProps) {
  const requestId = readRequestId(error);
  return (
    <Alert variant="destructive" data-slot="run-start-alert" data-problem={problem.kind}>
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>{problem.title}</AlertTitle>
      <AlertDescription>
        <p>{problem.message}</p>
        {problem.kind === "target_not_ready" && problem.missingEnvironment.length > 0 ? (
          <NameList
            label="Required environment values that are not set"
            names={problem.missingEnvironment}
          />
        ) : null}
        {problem.kind === "target_not_ready" && problem.missingInterfaces.length > 0 ? (
          <NameList label="Interfaces with no URL variable" names={problem.missingInterfaces} />
        ) : null}
        {problem.kind === "invalid" && problem.issues.length > 0 ? (
          <ul className="mt-2 list-disc pl-5">
            {problem.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        ) : null}
        <ProblemActions problem={problem} targetId={targetId} />
        {requestId === null ? null : (
          <p className="mt-2 font-mono text-xs">Request ID: {requestId}</p>
        )}
      </AlertDescription>
    </Alert>
  );
}
