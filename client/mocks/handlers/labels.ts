import { http } from "msw";
import type { Label, LabelTask } from "@/lib/api/types";
import { forbidden, notFound, validationFailed } from "../factories/errors";
import { QueryReader, readPage, type PageSpec } from "../factories/pagination";
import { nowIso } from "../factories/targets";
import { parseJsonObject } from "../factories/validation";
import { BodyReader } from "../stage1/body";
import { hashParts, pathUuid, withIdempotency } from "../stage1/support";
import { buildLabelStats } from "../stage10/labels-volume";
import { stageFour } from "../stage4/support";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

export const LABEL_SUBJECT_TYPES = [
  "probe_result",
  "judge_result",
  "invariant_result",
  "step",
] as const;
export const LABEL_VALUES = ["pass", "fail", "uncertain"] as const;
export const LABEL_SOURCES = ["human", "judge_weak"] as const;
export const LABEL_REASONS = ["uncertain", "judge_flagged", "disagreement", "audit"] as const;

const NOTE_MAX = 1000;

const TASK_PAGE: PageSpec<LabelTask> = {
  sortKeys: { created_at: { kind: "timestamp", value: (row) => row.created_at } },
  defaultSort: "created_at",
  getId: (row) => row.id,
};

const LABEL_PAGE: PageSpec<Label> = {
  sortKeys: { labeled_at: { kind: "timestamp", value: (row) => row.labeled_at } },
  defaultSort: "-labeled_at",
  getId: (row) => row.id,
};

async function listQueue(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "viewer");
  const query = new QueryReader(context.url.searchParams);
  const subjectTypes = query.enumList("subject_type", LABEL_SUBJECT_TYPES);
  const reasons = query.enumList("reason", LABEL_REASONS);
  const targetId = query.uuid("target_id");
  const paginate = readPage(query, TASK_PAGE);
  query.finish();

  const rows = stageFour(context)
    .labels.openTasksFor(user.id)
    .filter((entry) => targetId === undefined || entry.targetId === targetId.toLowerCase())
    .map((entry) => entry.task)
    .filter((task) => subjectTypes === undefined || subjectTypes.includes(task.subject_type))
    .filter((task) => reasons === undefined || reasons.includes(task.reason));
  return jsonResponse(paginate(rows));
}

async function listLabels(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const query = new QueryReader(context.url.searchParams);
  const subjectTypes = query.enumList("subject_type", LABEL_SUBJECT_TYPES);
  const subjectId = query.uuid("subject_id");
  const sources = query.enumList("source", LABEL_SOURCES);
  const labeledBy = query.uuid("labeled_by");
  const paginate = readPage(query, LABEL_PAGE);
  query.finish();

  const rows = stageFour(context)
    .labels.records.map((record) => record.label)
    .filter((label) => subjectTypes === undefined || subjectTypes.includes(label.subject_type))
    .filter((label) => subjectId === undefined || label.subject_id === subjectId.toLowerCase())
    .filter((label) => sources === undefined || sources.includes(label.source))
    .filter((label) => labeledBy === undefined || label.labeled_by === labeledBy.toLowerCase());
  return jsonResponse(paginate(rows));
}

async function createLabel(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  const body = new BodyReader(parseJsonObject(await context.request.text()));
  const subjectType = body.enum("subject_type", LABEL_SUBJECT_TYPES, { required: true });
  const subjectId = body.uuid("subject_id", { required: true });
  const value = body.enum("value", LABEL_VALUES, { required: true });
  const note = body.string("note", { required: false, nullable: true, max: NOTE_MAX });
  if (
    body.details.length > 0 ||
    subjectType === undefined ||
    subjectType === null ||
    subjectId === undefined ||
    subjectId === null ||
    value === undefined ||
    value === null
  ) {
    throw validationFailed(body.details);
  }
  const input = {
    subject_type: subjectType,
    subject_id: subjectId,
    value,
    note: note ?? null,
  };
  return withIdempotency(
    context,
    user,
    {
      required: false,
      requestHash: hashParts(subjectType, subjectId, value, input.note ?? ""),
    },
    () => {
      const saved = stageFour(context).labels.saveHuman(user.id, input, nowIso());
      const replaced = saved.replaced || context.state.faults.labelReplaced200;
      return { status: replaced ? 200 : 201, body: saved.label };
    },
  );
}

async function deleteLabel(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  const labelId = pathUuid(context, "label_id");
  const labels = stageFour(context).labels;
  const record = labels.findRecord(labelId);
  if (record === undefined) {
    throw notFound("Label not found");
  }
  if (record.label.source !== "human" || record.label.labeled_by !== user.id) {
    throw forbidden("Only your own human labels can be deleted");
  }
  labels.deleteRecord(labelId);
  return new Response(null, { status: 204 });
}

async function readStats(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  return jsonResponse(buildLabelStats(stageFour(context).labels));
}

export const labelHandlers = [
  http.get("*/api/v1/labels/queue", api(listQueue)),
  http.get("*/api/v1/labels/stats", api(readStats)),
  http.get("*/api/v1/labels", api(listLabels)),
  http.post("*/api/v1/labels", api(createLabel)),
  http.delete("*/api/v1/labels/:label_id", api(deleteLabel)),
];
