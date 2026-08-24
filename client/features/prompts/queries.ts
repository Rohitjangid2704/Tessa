import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { cursorInfiniteOptions } from "@/lib/api/pagination";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { PromptTemplateName } from "./types";

export const PROMPT_HISTORY_PAGE_SIZE = 10;
export const PROMPT_TEMPLATES_LIMIT = 200;
export const PROMPT_TEMPLATE_STALE_TIME_MS = 60 * 60 * 1000;

export function promptTemplatesQuery() {
  return queryOptions({
    queryKey: qk.promptTemplates.list(),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/prompt-templates", {
          params: { query: { limit: PROMPT_TEMPLATES_LIMIT } },
          signal,
        }),
      ),
    select: (page) => page.items,
    staleTime: PROMPT_TEMPLATE_STALE_TIME_MS,
  });
}

export function promptTemplateQuery(name: PromptTemplateName, version?: number) {
  return queryOptions({
    queryKey: qk.promptTemplates.detail(name, version),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/prompt-templates/{name}", {
          params: { path: { name }, query: { version } },
          signal,
        }),
      ),
    staleTime: PROMPT_TEMPLATE_STALE_TIME_MS,
  });
}

export function promptIssuesQuery(
  targetId: string,
  templateName?: PromptTemplateName,
  pageSize = PROMPT_HISTORY_PAGE_SIZE,
) {
  return cursorInfiniteOptions({
    queryKey: [...qk.targets.prompts(targetId, templateName), { pageSize }] as const,
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/targets/{target_id}/prompt-issues", {
          params: {
            path: { target_id: targetId },
            query: {
              template_name: templateName === undefined ? undefined : [templateName],
              cursor,
              limit: pageSize,
              include_total: true,
            },
          },
          signal,
        }),
      ),
  });
}

export function latestDiscoveryIssueQuery(targetId: string) {
  return queryOptions({
    queryKey: [...qk.targets.prompts(targetId, "discovery"), "latest"] as const,
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/targets/{target_id}/prompt-issues", {
          params: {
            path: { target_id: targetId },
            query: { template_name: ["discovery"], limit: 1 },
          },
          signal,
        }),
      ),
    select: (page) => page.items[0] ?? null,
  });
}

export function promptIssueQuery(promptIssueId: string) {
  return queryOptions({
    queryKey: qk.promptIssues.detail(promptIssueId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/prompt-issues/{prompt_issue_id}", {
          params: { path: { prompt_issue_id: promptIssueId } },
          signal,
        }),
      ),
    staleTime: Infinity,
  });
}
