"use client";

import { Loader2, PlugZap } from "lucide-react";
import { useId } from "react";
import { HealthTick } from "@/components/status/health-tick";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatLatency } from "@/features/system/dependencies";
import { describeTestRequestFailure } from "../errors";
import { useTestService } from "../mutations";
import { SERVICE_DEFINITIONS, type ServiceDefinition } from "../schemas";

export interface ServiceTestRowProps {
  definition: ServiceDefinition;
  readOnly: boolean;
}

export type ServiceTestState = "idle" | "running" | "ok" | "failed";

export function ServiceTestRow({ definition, readOnly }: ServiceTestRowProps) {
  const test = useTestService(definition.service);
  const result = test.data;
  const state: ServiceTestState = test.isPending
    ? "running"
    : test.isError || result?.ok === false
      ? "failed"
      : result?.ok === true
        ? "ok"
        : "idle";

  return (
    <li
      data-service={definition.service}
      data-state={state}
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-sm font-medium">{definition.label}</p>
        <p className="text-sm text-muted-foreground">{definition.description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="flex items-center gap-2 text-sm">
          {state === "running" ? (
            <>
              <Loader2
                aria-hidden="true"
                className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
              />
              Testing
            </>
          ) : null}
          {state === "ok" ? (
            <>
              <HealthTick status="ok" />
              <span className="text-muted-foreground">
                {formatLatency(result?.latency_ms ?? null)}
              </span>
            </>
          ) : null}
          {state === "failed" ? (
            <>
              <HealthTick status="failed" />
              <span className="text-muted-foreground">
                {test.isError
                  ? describeTestRequestFailure(test.error)
                  : (result?.message ?? "The service did not answer")}
              </span>
            </>
          ) : null}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={readOnly || test.isPending}
          onClick={() => test.mutate()}
        >
          {test.isPending ? "Testing" : "Test"}{" "}
          <span className="sr-only">{definition.label} connection</span>
        </Button>
      </div>
    </li>
  );
}

export function ServiceTestCard({ readOnly }: { readOnly: boolean }) {
  const titleId = useId();
  return (
    <Card role="region" aria-labelledby={titleId} data-section="service-tests">
      <CardHeader>
        <CardTitle id={titleId} role="heading" aria-level={2} className="flex items-center gap-2">
          <PlugZap aria-hidden="true" className="size-4" />
          Connectivity tests
        </CardTitle>
        <CardDescription>
          Free calls that check each service with what is stored now. They never send or show a key.
          {readOnly ? " Only admins can run them." : null}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul aria-label="Service connectivity" className="flex flex-col divide-y">
          {SERVICE_DEFINITIONS.map((definition) => (
            <ServiceTestRow key={definition.service} definition={definition} readOnly={readOnly} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
