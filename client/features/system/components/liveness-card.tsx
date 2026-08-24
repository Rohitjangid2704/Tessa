"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { useId } from "react";
import { HealthTick } from "@/components/status/health-tick";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiBaseUrl } from "@/lib/api/client";
import { describeApiError } from "@/lib/api/errors";
import { healthQuery } from "../queries";

export function LivenessCard() {
  const titleId = useId();
  const query = useQuery(healthQuery());

  return (
    <Card role="region" aria-labelledby={titleId}>
      <CardHeader>
        <CardTitle id={titleId} role="heading" aria-level={2} className="flex items-center gap-2">
          <Activity aria-hidden="true" className="size-4" />
          API
        </CardTitle>
        <CardDescription>Liveness of the Tessa API the browser talks to.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {query.isPending ? (
          <div role="status" aria-busy="true" className="flex flex-col gap-2">
            <span className="sr-only">Checking the API</span>
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-4 w-56" />
          </div>
        ) : query.isError ? (
          <>
            <HealthTick status="failed" />
            <p className="text-sm text-muted-foreground">{describeApiError(query.error)}</p>
          </>
        ) : (
          <>
            <HealthTick status="ok" />
            <p className="text-sm text-muted-foreground">The API is responding.</p>
          </>
        )}
        <p className="font-mono text-xs text-muted-foreground">{apiBaseUrl}</p>
      </CardContent>
    </Card>
  );
}
