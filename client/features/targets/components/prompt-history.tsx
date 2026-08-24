"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { DataTable, DataTableFooter, createDataTableColumnHelper } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { EmptyState } from "@/components/states/empty-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  PromptIssueDialog,
  TEMPLATE_LABELS,
} from "@/features/prompts/components/prompt-issue-dialog";
import { promptIssuesQuery } from "@/features/prompts/queries";
import type { PromptIssue } from "@/features/prompts/types";

const helper = createDataTableColumnHelper<PromptIssue>();

const HISTORY_COLUMNS = helper.columns([
  helper.accessor("template_name", {
    header: "Template",
    enableSorting: false,
    cell: (info) => `${TEMPLATE_LABELS[info.getValue()]} v${info.row.original.template_version}`,
  }),
  helper.accessor("issued_at", {
    header: "Issued",
    enableSorting: false,
    cell: (info) => <DateTime value={info.getValue()} />,
  }),
  helper.display({
    id: "open",
    header: () => <span className="sr-only">Open</span>,
    enableSorting: false,
    meta: { align: "end" },
    cell: (info) => (
      <PromptIssueDialog
        issueId={info.row.original.id}
        templateName={info.row.original.template_name}
        templateVersion={info.row.original.template_version}
      />
    ),
  }),
]);

export function PromptHistory({ targetId }: { targetId: string }) {
  const query = useInfiniteQuery(promptIssuesQuery(targetId));

  return (
    <Card data-slot="prompt-history">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Prompt history
        </CardTitle>
        <CardDescription>
          Every prompt issued for this target, newest first. Reopening one shows the exact text.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable<PromptIssue>
          label="Prompt history"
          columns={HISTORY_COLUMNS}
          data={query.data?.items}
          getRowId={(row) => row.id}
          isLoading={query.isPending}
          isFetching={query.isFetching}
          error={query.error}
          onRetry={() => void query.refetch()}
          skeletonRows={3}
          emptyState={
            <EmptyState
              title="No prompts issued yet"
              description="Generate the Discovery prompt above and it is listed here."
              icon={History}
              className="py-8"
            />
          }
          footer={
            <DataTableFooter
              noun="prompt"
              loadedCount={query.data?.loadedCount ?? 0}
              total={query.data?.total}
              hasNextPage={query.hasNextPage}
              isFetchingNextPage={query.isFetchingNextPage}
              onLoadMore={() => void query.fetchNextPage()}
            />
          }
        />
      </CardContent>
    </Card>
  );
}
