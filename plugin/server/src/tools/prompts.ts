import { z } from "zod";
import { unwrap } from "../client";
import { cutValue } from "../cut";
import { localError } from "../errors";
import type { Schemas } from "../types";
import { defineTool } from "./define";

const PROMPT_TEXT_CUT_BYTES = 55_000;

const TEMPLATES = ["discovery", "fixup", "explain", "author", "propose", "mutants", "hooks"] as const;

type Template = (typeof TEMPLATES)[number];

const discoveryParams = z
  .object({
    hint_ids: z.array(z.string()).max(50).optional(),
    template_version: z.number().int().min(1).optional(),
  })
  .strict();

const fixupParams = z.object({ bundle_id: z.string().uuid() }).strict();

const explainParams = z.object({ finding_id: z.string().uuid() }).strict();

const proposeParams = z
  .object({
    focus: z.array(z.string().min(1).max(120)).max(20).optional(),
    since_commit: z.string().regex(/^[0-9a-f]{7,40}$/, "since_commit is 7 to 40 lowercase hex digits").optional(),
  })
  .strict();

const authorParams = z
  .object({
    cell_ids: z.array(z.string().uuid()).min(1).max(50).optional(),
    proposal_item_ids: z.array(z.string().uuid()).min(1).max(50).optional(),
  })
  .strict()
  .refine(
    (params) => (params.cell_ids === undefined) !== (params.proposal_item_ids === undefined),
    "Pass exactly one of cell_ids and proposal_item_ids",
  );

const mutantsParams = z
  .object({ invariant_ids: z.array(z.string().min(1).max(120)).min(1).max(50) })
  .strict();

const hooksParams = z.object({ bundle_id: z.string().uuid() }).strict();

const PARAMS_BY_TEMPLATE: Record<Template, z.ZodType> = {
  discovery: discoveryParams,
  fixup: fixupParams,
  explain: explainParams,
  author: authorParams,
  propose: proposeParams,
  mutants: mutantsParams,
  hooks: hooksParams,
};

function checkParams(template: Template, params: Record<string, unknown>): void {
  const result = PARAMS_BY_TEMPLATE[template].safeParse(params);
  if (!result.success) {
    throw localError(
      "invalid_arguments",
      `The params of the ${template} prompt are invalid`,
      result.error.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        loc: issue.path.filter((part): part is string | number => typeof part !== "symbol"),
      })),
    );
  }
}

export const issuePrompt = defineTool({
  name: "issue_prompt",
  title: "Issue prompt",
  description:
    "Write (free, no model call). Asks Tessa for a versioned prompt of a template for a target and records the issue. Templates and their params: discovery (optional params.hint_ids and params.template_version), fixup (params.bundle_id, required), explain (params.finding_id, required), author (params.cell_ids or params.proposal_item_ids, exactly one), propose (optional params.focus areas, at most 20, and params.since_commit), mutants (params.invariant_ids, required), hooks (params.bundle_id, required). Params of another template are refused. Returns the prompt text as instructions to follow; where the text says to upload a zip, use validate_bundle and upload_bundle instead.",
  access: "write",
  idempotent: false,
  input: {
    target_id: z.string().uuid(),
    template: z.enum(TEMPLATES),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Template parameters, for example { finding_id } for explain, { bundle_id } for fixup and hooks, { proposal_item_ids } or { cell_ids } for author, { focus, since_commit } for propose"),
  },
  async handler(context, args) {
    checkParams(args.template, args.params ?? {});
    const body = { ...(args.params ?? {}), template_name: args.template } as Schemas["PromptIssueCreate"];
    const issue = await unwrap(
      context.api.client.POST("/api/v1/targets/{target_id}/prompt-issues", {
        params: { path: { target_id: args.target_id } },
        body,
      }),
    );
    const text = cutValue(issue.text, PROMPT_TEXT_CUT_BYTES);
    return {
      issue_id: issue.id,
      template_name: issue.template_name,
      template_version: issue.template_version,
      target_token: issue.target_token,
      text: text.value,
      text_truncated: text.truncated,
      text_bytes: Buffer.byteLength(issue.text),
    };
  },
});
