import type { components } from "@/lib/api/schema";
import { newId } from "./ids";
import { nowIso } from "./targets";

type Schemas = components["schemas"];

export type PromptTemplate = Schemas["PromptTemplate"];
export type PromptTemplatePage = Schemas["PromptTemplatePage"];
export type PromptIssue = Schemas["PromptIssue"];
export type PromptIssuePage = Schemas["PromptIssuePage"];
export type PromptIssueCreate = Schemas["PromptIssueCreate"];

export function buildPromptTemplate(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    name: "discovery",
    version: 1,
    text: "Prepare this repository. schema {{SCHEMA_URL}} token {{TARGET_TOKEN}}",
    variables: ["SCHEMA_URL", "TARGET_TOKEN"],
    created_at: nowIso(),
    ...overrides,
  };
}

export function buildPromptIssue(overrides: Partial<PromptIssue> = {}): PromptIssue {
  return {
    id: newId(),
    target_id: newId(),
    template_name: "discovery",
    template_version: 1,
    target_token: "tgt_abcdefghijklmnopqrstuv",
    text: "Prepare this repository.",
    params: { template_name: "discovery", hint_ids: [] },
    issued_by: newId(),
    issued_at: nowIso(),
    ...overrides,
  };
}

export function buildPromptIssuePage(
  items: readonly PromptIssue[],
  overrides: Partial<Omit<PromptIssuePage, "items">> = {},
): PromptIssuePage {
  return { items: [...items], next_cursor: null, total: null, ...overrides };
}

export function buildPromptTemplatePage(
  items: readonly PromptTemplate[],
  overrides: Partial<Omit<PromptTemplatePage, "items">> = {},
): PromptTemplatePage {
  return { items: [...items], next_cursor: null, total: null, ...overrides };
}
