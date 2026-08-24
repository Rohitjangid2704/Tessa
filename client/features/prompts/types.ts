import type { components } from "@/lib/api/schema";

type Schemas = components["schemas"];

export type PromptIssue = Schemas["PromptIssue"];
export type PromptIssueCreate = Schemas["PromptIssueCreate"];
export type PromptTemplate = Schemas["PromptTemplate"];
export type PromptTemplateName = Schemas["PromptTemplateName"];
