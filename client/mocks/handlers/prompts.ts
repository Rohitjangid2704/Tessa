import { http } from "msw";
import { conflict, notFound, validationFailed } from "../factories/errors";
import { newId } from "../factories/ids";
import { QueryReader, readPage, type PageSpec } from "../factories/pagination";
import type { PromptIssue } from "../factories/prompts";
import { nowIso } from "../factories/targets";
import { parseJsonObject } from "../factories/validation";
import { knownHintIds, toAppKindList } from "../fixtures/app-kinds";
import {
  findTemplate,
  PROMPT_TEMPLATES,
  toPromptTemplate,
  type PromptTemplateRecord,
} from "../fixtures/prompt-templates";
import { BodyReader } from "../stage1/body";
import { renderDiscovery, renderFixup } from "../stage1/render-prompt";
import { hashParts, pathUuid, requireTarget, stageOne, withIdempotency } from "../stage1/support";
import type { ErrorDetail } from "../types";
import { api, jsonResponse, pathParam, requireUser, type ApiContext } from "./api";

export const PROMPT_TEMPLATE_NAMES = [
  "discovery",
  "fixup",
  "explain",
  "author",
  "hooks",
  "mutants",
] as const;

export type PromptTemplateName = (typeof PROMPT_TEMPLATE_NAMES)[number];

const MAX_HINT_IDS = 50;
const TEMPLATE_TAGS = ["discovery", "fixup"] as const;

const TEMPLATE_PAGE: PageSpec<PromptTemplateRecord> = {
  sortKeys: {
    name: { kind: "text", value: (row) => row.name },
    version: { kind: "number", value: (row) => row.version },
    created_at: { kind: "timestamp", value: (row) => row.created_at },
  },
  defaultSort: "name,-version",
  getId: (row) => `${row.name}:${String(row.version).padStart(6, "0")}`,
};

const ISSUE_PAGE: PageSpec<PromptIssue> = {
  sortKeys: { issued_at: { kind: "timestamp", value: (row) => row.issued_at } },
  defaultSort: "-issued_at",
  getId: (row) => row.id,
};

function readAppKinds(context: ApiContext): Promise<Response> {
  return requireUser(context, "viewer").then(() => jsonResponse(toAppKindList()));
}

async function listTemplates(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const query = new QueryReader(context.url.searchParams);
  const paginate = readPage(query, TEMPLATE_PAGE);
  query.finish();
  const page = paginate(PROMPT_TEMPLATES);
  return jsonResponse({ ...page, items: page.items.map(toPromptTemplate) });
}

async function readTemplate(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const name = pathParam(context, "name");
  if (!PROMPT_TEMPLATE_NAMES.some((candidate) => candidate === name)) {
    throw validationFailed([
      {
        loc: ["path", "name"],
        code: "enum",
        message: `Input should be ${PROMPT_TEMPLATE_NAMES.map((value) => `'${value}'`).join(", ")}`,
      },
    ]);
  }
  const query = new QueryReader(context.url.searchParams);
  const version = query.integer("version", { min: 1 });
  query.finish();
  const template = findTemplate(name as PromptTemplateName, version ?? null);
  if (template === null) {
    throw notFound("Prompt template not found");
  }
  return jsonResponse(toPromptTemplate(template));
}

type IssueParams =
  | { template_name: "discovery"; hint_ids: string[] }
  | { template_name: "fixup"; bundle_id: string };

function parseIssueParams(raw: Record<string, unknown>): IssueParams {
  const tag = raw.template_name;
  const expected = TEMPLATE_TAGS.map((value) => `'${value}'`).join(" or ");
  if (tag === undefined) {
    throw validationFailed([
      {
        loc: ["body"],
        code: "union_tag_not_found",
        message: "Unable to extract tag using discriminator 'template_name'",
      },
    ]);
  }
  if (tag !== "discovery" && tag !== "fixup") {
    throw validationFailed([
      {
        loc: ["body"],
        code: "union_tag_invalid",
        message: `Input tag '${String(tag)}' found using 'template_name' does not match any of the expected tags: ${expected}`,
      },
    ]);
  }
  const reader = new BodyReader(raw, ["body", tag]);
  if (tag === "discovery") {
    const hintIds = reader.stringList("hint_ids", { maxItems: MAX_HINT_IDS });
    if (reader.details.length > 0) {
      throw validationFailed(reader.details);
    }
    return { template_name: "discovery", hint_ids: hintIds ?? [] };
  }
  const bundleId = reader.uuid("bundle_id", { required: true });
  if (reader.details.length > 0) {
    throw validationFailed(reader.details);
  }
  return { template_name: "fixup", bundle_id: bundleId as string };
}

async function createIssue(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  const targetId = pathUuid(context, "target_id");
  const rawText = await context.request.text();
  const params = parseIssueParams(parseJsonObject(rawText));
  return withIdempotency(
    context,
    user,
    { required: false, requestHash: hashParts("POST", context.url.pathname, rawText) },
    () => {
      const store = stageOne(context);
      const target = requireTarget(context, targetId);
      if (target.archivedAt !== null) {
        throw conflict("conflict", "The target is archived");
      }
      const template = findTemplate(params.template_name, null);
      if (template === null) {
        throw notFound("Prompt template not found");
      }
      let text: string;
      let storedParams: IssueParams = params;
      if (params.template_name === "discovery") {
        const known = knownHintIds(target.appKind);
        const hintIds = [...new Set(params.hint_ids)];
        const unknown: ErrorDetail[] = hintIds.flatMap((id, index) =>
          known.includes(id)
            ? []
            : [
                {
                  loc: ["body", "hint_ids", index],
                  code: "unknown_hint",
                  message: `Unknown hint '${id}' for app kind ${target.appKind}; allowed: ${known.join(", ")}`,
                },
              ],
        );
        if (unknown.length > 0) {
          throw validationFailed(unknown);
        }
        storedParams = { template_name: "discovery", hint_ids: hintIds };
        text = renderDiscovery({ template, target, hintIds, origin: context.url.origin });
      } else {
        const record = store.findBundle(params.bundle_id);
        if (record === undefined || record.bundle.target_id !== target.id) {
          throw notFound("Bundle not found for this target");
        }
        text = renderFixup({ template, target, record, origin: context.url.origin });
      }
      const issue: PromptIssue = {
        id: newId(),
        target_id: target.id,
        template_name: params.template_name,
        template_version: template.version,
        target_token: target.targetToken,
        text,
        params: { ...storedParams },
        issued_by: user.id,
        issued_at: nowIso(),
      };
      store.promptIssues.push(issue);
      return { status: 201, body: issue };
    },
  );
}

async function listIssues(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const targetId = pathUuid(context, "target_id");
  const query = new QueryReader(context.url.searchParams);
  const names = query.enumList("template_name", PROMPT_TEMPLATE_NAMES);
  const paginate = readPage(query, ISSUE_PAGE);
  query.finish();
  const target = requireTarget(context, targetId);
  const issues = stageOne(context).promptIssues.filter(
    (issue) =>
      issue.target_id === target.id && (names === undefined || names.includes(issue.template_name)),
  );
  return jsonResponse(paginate(issues));
}

async function readIssue(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const issueId = pathUuid(context, "prompt_issue_id");
  const issue = stageOne(context).promptIssues.find((candidate) => candidate.id === issueId);
  if (issue === undefined) {
    throw notFound("Prompt issue not found");
  }
  return jsonResponse(issue);
}

export const promptHandlers = [
  http.get("*/api/v1/app-kinds", api(readAppKinds)),
  http.get("*/api/v1/prompt-templates", api(listTemplates)),
  http.get("*/api/v1/prompt-templates/:name", api(readTemplate)),
  http.post("*/api/v1/targets/:target_id/prompt-issues", api(createIssue)),
  http.get("*/api/v1/targets/:target_id/prompt-issues", api(listIssues)),
  http.get("*/api/v1/prompt-issues/:prompt_issue_id", api(readIssue)),
];
