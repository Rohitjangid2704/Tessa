"use client";

import { SearchX } from "lucide-react";
import { DataTableFooter } from "@/components/data-table";
import { EmptyState } from "@/components/states/empty-state";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { OracleTemplate } from "../types";
import { ApprovalBadge, LanguageBadge, ReadOnlyBadge } from "./oracle-badges";

export interface TemplateListProps {
  templates: readonly OracleTemplate[];
  selectedId: string | null;
  onSelect: (templateId: string) => void;
  filtered: boolean;
  onClearFilters: () => void;
  loadedCount: number;
  total: number | null | undefined;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  className?: string;
}

export function TemplateList({
  templates,
  selectedId,
  onSelect,
  filtered,
  onClearFilters,
  loadedCount,
  total,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  className,
}: TemplateListProps) {
  return (
    <section
      data-slot="template-list"
      aria-label="Oracle templates"
      className={cn("flex flex-col gap-3", className)}
    >
      {templates.length === 0 ? (
        <EmptyState
          title={filtered ? "No templates match" : "No templates"}
          description={
            filtered
              ? "Change or clear the filters to see more templates."
              : "This bundle has no oracle templates."
          }
          icon={SearchX}
          className="py-10"
          action={
            filtered ? (
              <Button variant="outline" onClick={onClearFilters}>
                Show all templates
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {templates.map((template) => {
            const selected = template.id === selectedId;
            return (
              <li key={template.id}>
                <button
                  type="button"
                  data-template-id={template.id}
                  aria-current={selected ? "true" : undefined}
                  onClick={() => onSelect(template.id)}
                  className="flex w-full flex-col gap-2 rounded-xl border bg-card p-3 text-left transition-colors outline-none hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-current:border-primary aria-current:bg-muted"
                >
                  <span className="font-mono text-sm font-medium break-all">{template.name}</span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <LanguageBadge language={template.language} />
                    <ApprovalBadge approval={template.approval} />
                    {template.read_only_verified ? null : <ReadOnlyBadge verified={false} />}
                  </span>
                  {template.feature_ids.length > 0 ? (
                    <span className="text-xs break-all text-muted-foreground">
                      {template.feature_ids.join(", ")}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <DataTableFooter
        noun="template"
        loadedCount={loadedCount}
        total={total}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        onLoadMore={onLoadMore}
      />
    </section>
  );
}
