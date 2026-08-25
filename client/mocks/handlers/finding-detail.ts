import { http } from "msw";
import type { Explanation, Finding, FindingOccurrence } from "@/lib/api/types";
import { conflict, notFound, validationFailed } from "../factories/errors";
import { newId } from "../factories/ids";
import { QueryReader, readPage, type PageSpec } from "../factories/pagination";
import type { PromptIssue } from "../factories/prompts";
import { nowIso } from "../factories/targets";
import { parseJsonObject } from "../factories/validation";
import { findTemplate } from "../fixtures/prompt-templates";
import { BodyReader } from "../stage1/body";
import { renderExplain } from "../stage1/render-prompt";
import { hashParts, pathUuid, requireTarget, stageOne, withIdempotency } from "../stage1/support";
import { explanationsStore } from "../stage11/explanations-store";
import { readStructuredExplanation } from "../stage5/explanation-body";
import {
  buildOccurrences,
  buildPromotedScenario,
  buildRepro,
  findingDetailStore,
} from "../stage5/finding-detail-store";
import { findingsStore } from "../stage5/support";
import { stageTwo } from "../stage2/support";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

export const PROMOTE_TITLE_MAX = 200;

const OCCURRENCE_PAGE: PageSpec<FindingOccurrence> = {
  sortKeys: { seen_at: { kind: "timestamp", value: (row) => row.seen_at } },
  defaultSort: "-seen_at",
  getId: (row) => row.id,
};

const EXPLANATION_PAGE: PageSpec<Explanation> = {
  sortKeys: { created_at: { kind: "timestamp", value: (row) => row.created_at } },
  defaultSort: "-created_at",
  getId: (row) => row.id,
};

function requireFinding(context: ApiContext): Finding {
  const finding = findingsStore(context).find(pathUuid(context, "finding_id"));
  if (finding === undefined) {
    throw notFound("Finding not found");
  }
  return finding;
}

async function listOccurrences(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const query = new QueryReader(context.url.searchParams);
  const paginate = readPage(query, OCCURRENCE_PAGE);
  query.finish();
  const id = pathUuid(context, "finding_id");
  const record = findingsStore(context).findRecord(id);
  if (record === undefined) {
    throw notFound("Finding not found");
  }
  return jsonResponse(paginate(buildOccurrences(context, record)));
}

async function readRepro(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  return jsonResponse(buildRepro(context, requireFinding(context)));
}

async function listExplanations(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const query = new QueryReader(context.url.searchParams);
  const paginate = readPage(query, EXPLANATION_PAGE);
  query.finish();
  const finding = requireFinding(context);
  return jsonResponse(
    paginate(findingDetailStore(context).explanationsOf(finding.id, explanationsStore.structured)),
  );
}

async function createExplanation(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  const findingId = pathUuid(context, "finding_id");
  const rawText = await context.request.text();
  const body = new BodyReader(parseJsonObject(rawText));
  const limit = stageOne(context).limits.explanation_max_chars;
  const text = body.string("text", {
    required: true,
    min: 1,
    max: limit === null ? undefined : limit,
  });
  const structured = readStructuredExplanation(body);
  if (body.details.length > 0) {
    throw validationFailed(body.details);
  }
  return withIdempotency(
    context,
    user,
    { required: false, requestHash: hashParts("POST", context.url.pathname, rawText) },
    () => {
      const findings = findingsStore(context);
      const finding = findings.find(findingId);
      if (finding === undefined) {
        throw notFound("Finding not found");
      }
      const explanation: Explanation = {
        id: newId(),
        finding_id: finding.id,
        text: text as string,
        source: "claude_code",
        created_by: user.id,
        created_at: nowIso(),
        structured: structured ?? null,
      };
      findingDetailStore(context).addExplanation(explanation, explanationsStore.structured);
      findings.replace({ ...finding, latest_explanation: explanation });
      return { status: 201, body: explanation };
    },
  );
}

async function promoteFinding(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  const findingId = pathUuid(context, "finding_id");
  const rawText = await context.request.text();
  const body = new BodyReader(parseJsonObject(rawText));
  const title = body.string("title", {
    required: false,
    nullable: true,
    min: 1,
    max: PROMOTE_TITLE_MAX,
    strip: true,
  });
  if (body.details.length > 0) {
    throw validationFailed(body.details);
  }
  return withIdempotency(
    context,
    user,
    { required: false, requestHash: hashParts("POST", context.url.pathname, rawText) },
    () => {
      const findings = findingsStore(context);
      const finding = findings.find(findingId);
      if (finding === undefined) {
        throw notFound("Finding not found");
      }
      if (finding.promoted_scenario_id !== null) {
        throw conflict("conflict", "This finding was already promoted to a scenario");
      }
      const scenario = buildPromotedScenario(context, finding, title ?? null);
      stageTwo(context).addScenario({ scenario, cellKey: null });
      findings.replace({ ...finding, promoted_scenario_id: scenario.id });
      return { status: 201, body: scenario };
    },
  );
}

function isExplainBody(rawText: string): boolean {
  try {
    const parsed: unknown = JSON.parse(rawText);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      Reflect.get(parsed, "template_name") === "explain"
    );
  } catch {
    return false;
  }
}

async function createExplainIssue(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  const targetId = pathUuid(context, "target_id");
  const rawText = await context.request.text();
  const reader = new BodyReader(parseJsonObject(rawText), ["body", "explain"]);
  const findingId = reader.uuid("finding_id", { required: true });
  if (reader.details.length > 0) {
    throw validationFailed(reader.details);
  }
  return withIdempotency(
    context,
    user,
    { required: false, requestHash: hashParts("POST", context.url.pathname, rawText) },
    () => {
      const target = requireTarget(context, targetId);
      if (target.archivedAt !== null) {
        throw conflict("conflict", "The target is archived");
      }
      const finding = findingsStore(context).find(findingId as string);
      if (finding === undefined || finding.target_id !== target.id) {
        throw notFound("Finding not found for this target");
      }
      const template = findTemplate("explain", null);
      if (template === null) {
        throw notFound("Prompt template not found");
      }
      const issue: PromptIssue = {
        id: newId(),
        target_id: target.id,
        template_name: "explain",
        template_version: template.version,
        target_token: target.targetToken,
        text: renderExplain({ template, target, finding }),
        params: { template_name: "explain", finding_id: finding.id },
        issued_by: user.id,
        issued_at: nowIso(),
      };
      stageOne(context).promptIssues.push(issue);
      return { status: 201, body: issue };
    },
  );
}

const resolveExplainIssue = api(createExplainIssue);

export const findingDetailHandlers = [
  http.post("*/api/v1/targets/:target_id/prompt-issues", async (info) => {
    const rawText = await info.request.clone().text();
    return isExplainBody(rawText) ? resolveExplainIssue(info) : undefined;
  }),
  http.get("*/api/v1/findings/:finding_id/occurrences", api(listOccurrences)),
  http.get("*/api/v1/findings/:finding_id/repro", api(readRepro)),
  http.get("*/api/v1/findings/:finding_id/explanations", api(listExplanations)),
  http.post("*/api/v1/findings/:finding_id/explanations", api(createExplanation)),
  http.post("*/api/v1/findings/:finding_id/promote", api(promoteFinding)),
];
