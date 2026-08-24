"use client";

import { useQuery } from "@tanstack/react-query";
import { Network, RefreshCw, TriangleAlert } from "lucide-react";
import { useId } from "react";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { describeApiError } from "@/lib/api/errors";
import { downDependencyLabels, formatLatency, toDependencyRows } from "../dependencies";
import { dependencyHealthQuery } from "../queries";
import { DependencyStatusBadge } from "./dependency-status-badge";

export function DependenciesCard() {
  const titleId = useId();
  const query = useQuery(dependencyHealthQuery());
  const rows = query.data ? toDependencyRows(query.data) : [];
  const downLabels = downDependencyLabels(rows);

  return (
    <Card role="region" aria-labelledby={titleId}>
      <CardHeader>
        <CardTitle id={titleId} role="heading" aria-level={2} className="flex items-center gap-2">
          <Network aria-hidden="true" className="size-4" />
          Dependencies
        </CardTitle>
        <CardDescription>
          What the API reaches: the database, Temporal, Laya and file storage.
        </CardDescription>
        <CardAction>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh dependency status"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw
              aria-hidden="true"
              className={query.isFetching ? "animate-spin motion-reduce:animate-none" : undefined}
            />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {query.isPending ? (
          <div role="status" aria-busy="true" className="flex flex-col gap-2">
            <span className="sr-only">Checking dependencies</span>
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
          </div>
        ) : query.isError ? (
          <ErrorState
            title="Dependency status unavailable"
            description={describeApiError(query.error)}
            requestId={readRequestId(query.error)}
            onRetry={() => void query.refetch()}
            className="py-8"
          />
        ) : (
          <>
            {downLabels.length > 0 ? (
              <Alert variant="destructive">
                <TriangleAlert aria-hidden="true" />
                <AlertTitle>
                  {downLabels.length === 1
                    ? "1 dependency is down"
                    : `${downLabels.length} dependencies are down`}
                </AlertTitle>
                <AlertDescription>
                  {downLabels.join(", ")}. Work that needs it will fail until it is back.
                </AlertDescription>
              </Alert>
            ) : null}
            <Table>
              <TableCaption className="sr-only">Status of the API dependencies</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Dependency</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Latency</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.key} data-dependency={row.key}>
                    <TableCell className="font-medium">{row.label}</TableCell>
                    <TableCell>
                      <DependencyStatusBadge status={row.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatLatency(row.latencyMs)}
                    </TableCell>
                    <TableCell className="whitespace-normal text-muted-foreground">
                      {row.detail}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  );
}
