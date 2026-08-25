import { http } from "msw";
import { conflict, notFound, validationFailed } from "../factories/errors";
import { QueryReader, readPage, type PageSpec } from "../factories/pagination";
import { parseJsonObject } from "../factories/validation";
import { BodyReader } from "../stage1/body";
import {
  hashParts,
  pathUuid,
  requireIdempotencyKey,
  requireTarget,
  stageOne,
  withIdempotency,
} from "../stage1/support";
import { computeOutcome } from "../stage3/oracle/outcome";
import { validateOracleParams } from "../stage3/oracle/params";
import type { OracleResultRecord, OracleTemplateRecord } from "../stage3/oracle/store";
import { bundleIdOfTemplate, toOracleResult, toOracleTemplate } from "../stage3/oracle/views";
import { oracleStore } from "../stage3/support";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

const APPROVALS = ["unreviewed", "approved", "rejected"] as const;

const TEMPLATE_PAGE: PageSpec<OracleTemplateRecord> = {
  sortKeys: { name: { kind: "text", value: (row) => row.name } },
  defaultSort: "name",
  getId: (row) => row.id,
};

const RESULT_PAGE: PageSpec<OracleResultRecord> = {
  sortKeys: { executed_at: { kind: "number", value: (row) => row.settleAtMs } },
  defaultSort: "-executed_at",
  getId: (row) => row.id,
};

function requireTemplate(context: ApiContext): OracleTemplateRecord {
  const template = oracleStore(context).findTemplate(pathUuid(context, "oracle_template_id"));
  if (template === undefined) {
    throw notFound("Oracle template not found");
  }
  return template;
}

async function listTemplates(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const query = new QueryReader(context.url.searchParams);
  const targetId = query.uuid("target_id");
  const bundleId = query.uuid("bundle_id");
  const featureIds = query.stringList("feature_id");
  const approvals = query.enumList("approval", APPROVALS);
  const paginate = readPage(query, TEMPLATE_PAGE);
  query.finish();

  const store = stageOne(context);
  if (targetId !== undefined) {
    requireTarget(context, targetId);
  }
  const visible = oracleStore(context).templates.filter((template) => {
    const currentBundleId = bundleIdOfTemplate(store, template);
    return (
      currentBundleId !== null &&
      (targetId === undefined || template.targetId === targetId) &&
      (bundleId === undefined || currentBundleId === bundleId) &&
      (featureIds === undefined ||
        featureIds.some((featureId) => template.featureIds.includes(featureId))) &&
      (approvals === undefined || approvals.includes(template.approval))
    );
  });
  const page = paginate(visible);
  return jsonResponse({
    ...page,
    items: page.items.map((template) => toOracleTemplate(store, template)),
  });
}

async function readTemplate(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const template = requireTemplate(context);
  return jsonResponse(toOracleTemplate(stageOne(context), template));
}

async function startRun(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  const template = requireTemplate(context);
  requireIdempotencyKey(context);
  const body = parseJsonObject(await context.request.text());
  const reader = new BodyReader(body);
  const params = reader.object("params", { nullable: false });
  if (params === undefined && !reader.has("params")) {
    reader.issue("params", "missing", "Field required");
  }
  const details = [
    ...reader.details,
    ...(params === undefined || params === null
      ? []
      : validateOracleParams(template.paramsSchema, params)),
  ];
  if (details.length > 0 || params === undefined || params === null) {
    throw validationFailed(details);
  }
  const requestHash = hashParts("oracle-run", template.id, JSON.stringify(params));
  return withIdempotency(context, user, { required: true, requestHash }, () => {
    const store = oracleStore(context);
    const startedAtMs = Date.now();
    const settleMs = store.settleOverrideMs ?? template.behavior.settleMs;
    const record = store.addResult({
      templateId: template.id,
      params,
      startedAtMs,
      settleAtMs: startedAtMs + settleMs,
      outcome: computeOutcome(template, params, { forceError: context.state.faults.oracleError }),
    });
    return { status: 202, body: toOracleResult(record, Number.NEGATIVE_INFINITY) };
  });
}

async function readResult(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const record = oracleStore(context).findResult(pathUuid(context, "oracle_result_id"));
  if (record === undefined) {
    throw notFound("Oracle result not found");
  }
  return jsonResponse(toOracleResult(record, Date.now()));
}

async function listResults(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const template = requireTemplate(context);
  const query = new QueryReader(context.url.searchParams);
  const paginate = readPage(query, RESULT_PAGE);
  query.finish();
  const page = paginate(oracleStore(context).resultsOf(template.id));
  const nowMs = Date.now();
  return jsonResponse({
    ...page,
    items: page.items.map((record) => toOracleResult(record, nowMs)),
  });
}

async function setApproval(context: ApiContext): Promise<Response> {
  await requireUser(context, "member");
  const template = requireTemplate(context);
  const body = parseJsonObject(await context.request.text());
  const reader = new BodyReader(body);
  const approved = reader.boolean("approved", {});
  if (approved === undefined && !reader.has("approved")) {
    reader.issue("approved", "missing", "Field required");
  }
  const resultId = reader.uuid("oracle_result_id", { required: true });
  if (reader.details.length > 0 || typeof approved !== "boolean" || typeof resultId !== "string") {
    throw validationFailed(reader.details);
  }
  const store = oracleStore(context);
  const record = store.findResult(resultId);
  if (record === undefined || record.templateId !== template.id) {
    throw validationFailed([
      {
        loc: ["body", "oracle_result_id"],
        code: "oracle_result_not_found",
        message: "The result does not exist or belongs to another template",
      },
    ]);
  }
  if (Date.now() < record.settleAtMs || record.outcome.status !== "ok") {
    throw conflict("conflict", "Only a finished result with status ok can be approved or rejected");
  }
  if (approved && !template.readOnlyVerified) {
    throw conflict(
      "conflict",
      "The template is not verified as read-only, so it cannot be approved",
    );
  }
  template.approval = approved ? "approved" : "rejected";
  return jsonResponse(toOracleTemplate(stageOne(context), template));
}

export const oracleHandlers = [
  http.get("*/api/v1/oracle-templates", api(listTemplates)),
  http.get("*/api/v1/oracle-templates/:oracle_template_id", api(readTemplate)),
  http.post("*/api/v1/oracle-templates/:oracle_template_id/runs", api(startRun)),
  http.get("*/api/v1/oracle-templates/:oracle_template_id/results", api(listResults)),
  http.put("*/api/v1/oracle-templates/:oracle_template_id/approval", api(setApproval)),
  http.get("*/api/v1/oracle-results/:oracle_result_id", api(readResult)),
];
