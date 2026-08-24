"use client";

import { useQuery } from "@tanstack/react-query";
import { ExternalLink, FileJson } from "lucide-react";
import { useId } from "react";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { schemaFileName, shortSha } from "../schemas";
import { schemaIndexQuery } from "../queries";

export function SchemasCard() {
  const titleId = useId();
  const query = useQuery(schemaIndexQuery());

  return (
    <Card role="region" aria-labelledby={titleId}>
      <CardHeader>
        <CardTitle id={titleId} role="heading" aria-level={2} className="flex items-center gap-2">
          <FileJson aria-hidden="true" className="size-4" />
          Schemas
        </CardTitle>
        <CardDescription>
          JSON Schemas the API publishes. Prompts and editors cite these URLs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <div role="status" aria-busy="true" className="flex flex-col gap-2">
            <span className="sr-only">Loading the schema index</span>
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
          </div>
        ) : query.isError ? (
          <ErrorState
            title="Schema index unavailable"
            description={describeApiError(query.error)}
            requestId={readRequestId(query.error)}
            onRetry={() => void query.refetch()}
            className="py-8"
          />
        ) : query.data.schemas.length === 0 ? (
          <p className="text-sm text-muted-foreground">The API has not published any schemas.</p>
        ) : (
          <Table>
            <TableCaption className="sr-only">Published JSON Schemas</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Schema</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead>SHA-256</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.schemas.map((schema) => (
                <TableRow key={schemaFileName(schema)}>
                  <TableCell className="font-medium">
                    <a
                      href={schema.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 underline underline-offset-4 hover:text-foreground"
                    >
                      {schemaFileName(schema)}
                      <ExternalLink aria-hidden="true" className="size-3" />
                    </a>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{schema.stage}</TableCell>
                  <TableCell
                    className="font-mono text-xs text-muted-foreground"
                    title={schema.sha256}
                  >
                    {shortSha(schema.sha256)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
