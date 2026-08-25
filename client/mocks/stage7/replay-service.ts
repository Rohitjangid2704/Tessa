import { conflict, MockApiError, notFound, validationFailed } from "../factories/errors";
import { DEFAULT_REPLAY_MAX_BYTES } from "../factories/limits";
import { launchRun } from "../server/run-simulator";
import { assertTeamBudget } from "../stage10/teams-guard";
import { stableId, stableUnit } from "../stage2/ids";
import { buildConfigSnapshot, DEFAULT_RUN_BUDGET, resolveBundle } from "../stage2/plan-service";
import { nowIso } from "../stage2/support";
import type { MockState } from "../state";
import type { MockUser } from "../types";
import type { Replay, ReplayReasonCode, ReplayRecord } from "@/lib/api/types";
import {
  FAKE_EXCERPTS,
  REPLAY_BYTES_PER_FAKE_RECORD,
  REPLAY_EXTENSIONS,
  REPLAY_FAKE_MAX_RECORDS,
  REPLAY_FAKE_MIN_RECORDS,
  REPLAY_HEAD_LINES,
  REPLAY_MAX_RECORDS,
  REPLAY_PARSE_LIMIT_BYTES,
  REPLAY_REASONS,
  UNSTABLE_MARKER,
  ZERO_CASES_MARKER,
  redactExcerpt,
} from "./replay-data";
import { replayStore, type ReplayEntry } from "./replay-store";
import { isProductionBlocked, productionBlockedFor } from "./redteam-service";

export interface RecordDraft {
  excerpt: string;
  reasonCode: ReplayReasonCode | null;
  scenarioId?: string;
  scenarioStatus?: "in_review" | "accepted";
}

export interface ReplayParams {
  replay_id: string;
}

export function replayMaxBytes(state: MockState): number {
  return state.stageOne.limits.replay_max_bytes ?? DEFAULT_REPLAY_MAX_BYTES;
}

function payloadTooLarge(limit: number, size: number): MockApiError {
  const message = `The export is ${size} bytes; the server accepts at most ${limit} bytes`;
  return new MockApiError(413, "payload_too_large", message, [
    { loc: ["file"], code: "replay_too_large", message },
  ]);
}

function unsupportedFormat(fileName: string): MockApiError {
  const message = `${fileName} is not a JSONL or JSON export`;
  return new MockApiError(415, "unsupported_media_type", message, [
    { loc: ["form", "file"], code: "unsupported_media_type", message },
  ]);
}

function unparseable(line: number, message: string): MockApiError {
  return validationFailed([{ loc: ["file", line], code: "replay_unparseable", message }]);
}

export function extensionOf(fileName: string): string | null {
  const lowered = fileName.toLowerCase();
  return REPLAY_EXTENSIONS.find((extension) => lowered.endsWith(extension)) ?? null;
}

interface ExportRecord {
  conversationId: string | null;
  excerpt: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function excerptOf(messages: readonly unknown[]): string {
  const turns = messages
    .filter(isObject)
    .slice(0, 2)
    .map((message) => {
      const role = typeof message.role === "string" ? message.role : "user";
      const content = typeof message.content === "string" ? message.content : "";
      return `[${role}] ${content}`;
    });
  return redactExcerpt(turns.join(" "));
}

function toExportRecord(value: unknown): ExportRecord {
  if (!isObject(value)) {
    return { conversationId: null, excerpt: "" };
  }
  const conversationId = typeof value.conversation_id === "string" ? value.conversation_id : null;
  const messages = Array.isArray(value.messages) ? value.messages : null;
  if (conversationId === null || messages === null || messages.length === 0) {
    return { conversationId: null, excerpt: "" };
  }
  return { conversationId, excerpt: excerptOf(messages) };
}

export function parseExportText(text: string, extension: string): ExportRecord[] {
  if (extension === ".json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw unparseable(1, "The file is not valid JSON");
    }
    const list = Array.isArray(parsed)
      ? parsed
      : isObject(parsed) && Array.isArray(parsed.records)
        ? parsed.records
        : [parsed];
    return list.map(toExportRecord);
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  return lines.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (index < REPLAY_HEAD_LINES) {
        throw unparseable(index + 1, "This line is not valid JSON");
      }
      return { conversationId: null, excerpt: "" };
    }
    if (index < REPLAY_HEAD_LINES && toExportRecord(value).conversationId === null) {
      throw unparseable(index + 1, "This line has no conversation_id or no messages");
    }
    return toExportRecord(value);
  });
}

function fakeRecords(sizeBytes: number): ExportRecord[] {
  const count = Math.min(
    REPLAY_FAKE_MAX_RECORDS,
    Math.max(REPLAY_FAKE_MIN_RECORDS, Math.floor(sizeBytes / REPLAY_BYTES_PER_FAKE_RECORD)),
  );
  return Array.from({ length: count }, (_, index) => ({
    conversationId: `conversation-${index}`,
    excerpt: FAKE_EXCERPTS[index % FAKE_EXCERPTS.length] ?? "",
  }));
}

function reasonFor(
  replayId: string,
  fileName: string,
  seenIds: Set<string>,
  record: ExportRecord,
  index: number,
): ReplayReasonCode | null {
  if (index >= REPLAY_MAX_RECORDS) {
    return "over_record_cap";
  }
  if (record.conversationId === null) {
    return "invalid";
  }
  if (seenIds.has(record.conversationId)) {
    return "duplicate";
  }
  seenIds.add(record.conversationId);
  const name = fileName.toLowerCase();
  if (name.includes(ZERO_CASES_MARKER)) {
    return "validation_failed";
  }
  const unit = stableUnit("replay_outcome", replayId, index);
  const unstableShare = name.includes(UNSTABLE_MARKER) ? 0.5 : 0.07;
  if (unit < unstableShare) {
    return "unstable";
  }
  return unit < unstableShare + 0.05 ? "validation_failed" : null;
}

export function draftsFromExport(
  replayId: string,
  fileName: string,
  records: readonly ExportRecord[],
): RecordDraft[] {
  const seenIds = new Set<string>();
  return records.map((record, index) => ({
    excerpt: record.excerpt === "" ? "[no readable messages]" : record.excerpt,
    reasonCode: reasonFor(replayId, fileName, seenIds, record, index),
  }));
}

export function buildReplayEntry(input: {
  replayId: string;
  runId: string;
  targetId: string;
  sourceName: string;
  createdAt: string;
  drafts: readonly RecordDraft[];
}): ReplayEntry {
  const statuses = new Map<string, "in_review" | "accepted">();
  const records: ReplayRecord[] = [];
  const outcomes: ReplayRecord[] = [];
  input.drafts.forEach((draft, index) => {
    const base = {
      id: stableId("replay_record", input.replayId, index),
      replay_id: input.replayId,
      index,
      excerpt: draft.excerpt,
    };
    records.push({
      ...base,
      status: "pending",
      reason_code: null,
      reason: null,
      scenario_id: null,
    });
    if (draft.reasonCode === null) {
      const scenarioId = draft.scenarioId ?? stableId("scenario_replay", input.replayId, index);
      statuses.set(scenarioId, draft.scenarioStatus ?? "in_review");
      outcomes.push({
        ...base,
        status: "created",
        reason_code: null,
        reason: null,
        scenario_id: scenarioId,
      });
      return;
    }
    outcomes.push({
      ...base,
      status: "rejected",
      reason_code: draft.reasonCode,
      reason: REPLAY_REASONS[draft.reasonCode],
      scenario_id: null,
    });
  });
  return {
    replayId: input.replayId,
    runId: input.runId,
    targetId: input.targetId,
    sourceName: input.sourceName,
    createdAt: input.createdAt,
    records,
    outcomes,
    scenarioStatuses: statuses,
  };
}

export function toReplay(state: MockState, entry: ReplayEntry): Replay {
  const created = entry.records.filter((record) => record.status === "created").length;
  const rejected = entry.records.filter((record) => record.status === "rejected").length;
  return {
    id: entry.replayId,
    run_id: entry.runId,
    target_id: entry.targetId,
    source_name: entry.sourceName,
    records_total: entry.records.length,
    cases_created: created,
    cases_rejected: rejected,
    status: state.stageTwo.findRun(entry.runId)?.run.status ?? "queued",
    created_at: entry.createdAt,
  };
}

export interface ReplayUploadInput {
  fileName: string;
  sizeBytes: number;
  readText: () => Promise<string>;
  targetId: string;
  forcedTooLarge: boolean;
}

export async function startReplay(
  state: MockState,
  user: MockUser,
  input: ReplayUploadInput,
): Promise<Replay> {
  const limit = replayMaxBytes(state);
  if (input.forcedTooLarge || input.sizeBytes > limit) {
    throw payloadTooLarge(limit, input.sizeBytes);
  }
  const extension = extensionOf(input.fileName);
  if (extension === null) {
    throw unsupportedFormat(input.fileName);
  }
  const { stageOne, stageTwo: store } = state;
  store.ensure();
  const target = stageOne.findTarget(input.targetId);
  if (target === undefined) {
    throw notFound("Target not found");
  }
  if (target.archivedAt !== null) {
    throw conflict("conflict", "The target is archived");
  }
  if (isProductionBlocked(state, target.tier)) {
    throw productionBlockedFor(target.name, "replays");
  }
  assertTeamBudget(state, target.id);
  const parsed =
    input.sizeBytes <= REPLAY_PARSE_LIMIT_BYTES
      ? parseExportText(await input.readText(), extension)
      : fakeRecords(input.sizeBytes);
  const bundle = resolveBundle(stageOne, target, null);
  const replayId = stableId("replay_live", replayStore.entries.length + 1);
  const runId = stableId("run_live", store.nextOrdinal("run"));
  const createdAt = nowIso();
  const entry = buildReplayEntry({
    replayId,
    runId,
    targetId: target.id,
    sourceName: input.fileName,
    createdAt,
    drafts: draftsFromExport(replayId, input.fileName, parsed),
  });
  replayStore.add(entry);
  const params: ReplayParams = { replay_id: replayId };
  launchRun(state, store, {
    id: runId,
    kind: "replay",
    createdBy: user.id,
    targetId: target.id,
    planId: null,
    bundleId: bundle.bundle.id,
    readOnly: false,
    budget: { ...DEFAULT_RUN_BUDGET },
    configSnapshot: buildConfigSnapshot(bundle, createdAt),
    params: { ...params },
  });
  return toReplay(state, entry);
}

export function readReplayParams(params: Record<string, unknown>): ReplayParams {
  return { replay_id: typeof params.replay_id === "string" ? params.replay_id : "" };
}
