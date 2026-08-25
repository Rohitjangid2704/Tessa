import { http } from "msw";
import { notFound, validationFailed } from "../factories/errors";
import { QueryReader, readPage, type PageSpec } from "../factories/pagination";
import { hashParts, pathUuid, requireIdempotencyKey, withIdempotency } from "../stage1/support";
import { BodyReader } from "../stage1/body";
import "../streams/replay-script";
import { REPLAY_REASON_CODES } from "../stage7/replay-data";
import { startReplay, toReplay } from "../stage7/replay-service";
import { replayStore, type ReplayEntry } from "../stage7/replay-store";
import type { Replay, ReplayRecord, ReplayRecordStatus } from "@/lib/api/types";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

const NOTE_MAX = 500;
const RECORD_STATUSES: readonly ReplayRecordStatus[] = ["pending", "created", "rejected"];

const REPLAY_PAGE: PageSpec<Replay> = {
  sortKeys: { created_at: { kind: "timestamp", value: (row) => row.created_at } },
  defaultSort: "-created_at",
  getId: (row) => row.id,
};

const RECORD_PAGE: PageSpec<ReplayRecord> = {
  sortKeys: { index: { kind: "number", value: (row) => row.index } },
  defaultSort: "index",
  getId: (row) => row.id,
};

function requireReplay(context: ApiContext): ReplayEntry {
  context.state.stageTwo.ensure();
  const entry = replayStore.find(pathUuid(context, "replay_id"));
  if (entry === undefined) {
    throw notFound("Replay not found");
  }
  return entry;
}

async function readUploadForm(context: ApiContext): Promise<FormData> {
  try {
    return await context.request.formData();
  } catch {
    throw validationFailed([{ loc: ["body", "file"], code: "missing", message: "Field required" }]);
  }
}

async function uploadReplay(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  requireIdempotencyKey(context);
  const form = await readUploadForm(context);
  const file = form.get("file");
  const rawTarget = form.get("target_id");
  const rawNote = form.get("note");
  const reader = new BodyReader({
    target_id: typeof rawTarget === "string" && rawTarget !== "" ? rawTarget : undefined,
    note: typeof rawNote === "string" ? rawNote : undefined,
  });
  const targetId = reader.uuid("target_id", { required: true });
  const note = reader.string("note", { required: false, max: NOTE_MAX });
  const problems = [...reader.details];
  if (file === null || typeof file === "string") {
    problems.unshift({ loc: ["body", "file"], code: "missing", message: "Field required" });
  }
  if (problems.length > 0 || file === null || typeof file === "string" || !targetId) {
    throw validationFailed(problems);
  }
  const requestHash = hashParts(
    "POST",
    context.url.pathname,
    file.name,
    String(file.size),
    targetId,
    note ?? "",
  );
  return withIdempotency(context, user, { required: true, requestHash }, async () => ({
    status: 202,
    body: await startReplay(context.state, user, {
      fileName: file.name,
      sizeBytes: file.size,
      readText: () => file.text(),
      targetId,
      forcedTooLarge: context.state.faults.upload413,
    }),
  }));
}

async function listReplays(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  context.state.stageTwo.ensure();
  const query = new QueryReader(context.url.searchParams);
  const paginate = readPage(query, REPLAY_PAGE);
  query.finish();
  return jsonResponse(paginate(replayStore.entries.map((entry) => toReplay(context.state, entry))));
}

async function readReplay(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  return jsonResponse(toReplay(context.state, requireReplay(context)));
}

async function listRecords(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const entry = requireReplay(context);
  const query = new QueryReader(context.url.searchParams);
  const statuses = query.enumList("status", RECORD_STATUSES);
  const reasonCodes = query.enumList("reason_code", REPLAY_REASON_CODES);
  const paginate = readPage(query, RECORD_PAGE);
  query.finish();
  const rows = entry.records.filter(
    (record) =>
      (statuses === undefined || statuses.includes(record.status)) &&
      (reasonCodes === undefined ||
        (record.reason_code !== null && reasonCodes.includes(record.reason_code))),
  );
  return jsonResponse(paginate(rows));
}

export const replayHandlers = [
  http.post("*/api/v1/replays", api(uploadReplay)),
  http.get("*/api/v1/replays", api(listReplays)),
  http.get("*/api/v1/replays/:replay_id/records", api(listRecords)),
  http.get("*/api/v1/replays/:replay_id", api(readReplay)),
];
