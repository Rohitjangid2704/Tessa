import { z } from "zod";
import { runStatusSchema } from "@/features/streams/events";
import type { Replay, ReplayReasonCode, ReplayRecordStatus } from "@/lib/api/types";
import { createSearchParamsCodec, enumListParam, uuidParam } from "@/lib/search-params";
import { targetIdParam } from "@/features/targets/target-id-param";

export const REPLAY_EXTENSIONS = [".jsonl", ".json"] as const;
export const REPLAY_HEAD_RECORDS = 5;
export const REPLAY_HEAD_BYTES = 262_144;
export const REPLAY_WHOLE_FILE_PARSE_BYTES = 2_097_152;
export const REPLAY_NOTE_MAX_LENGTH = 500;

export const REPLAY_RECORD_STATUSES = [
  "pending",
  "created",
  "rejected",
] as const satisfies readonly ReplayRecordStatus[];

export const REPLAY_REASON_CODES = [
  "duplicate",
  "unstable",
  "invalid",
  "over_record_cap",
  "validation_failed",
] as const satisfies readonly ReplayReasonCode[];

export function hasReplayExtension(fileName: string): boolean {
  const lowered = fileName.toLowerCase();
  return REPLAY_EXTENSIONS.some((extension) => lowered.endsWith(extension));
}

export function createReplayFileSchema(maxBytes: number | null) {
  return z.object({
    name: z
      .string()
      .refine(hasReplayExtension, "Only .jsonl and .json production exports are accepted"),
    size: z
      .number()
      .refine((size) => size > 0, "The file is empty")
      .refine(
        (size) => maxBytes === null || size <= maxBytes,
        "The file is larger than the server accepts",
      ),
  });
}

export const replayFileSchema = createReplayFileSchema(null);

export const replayRecordHeadSchema = z.looseObject({
  conversation_id: z.string().min(1),
  messages: z.array(z.unknown()).min(1),
});

export const replayNoteSchema = z
  .string()
  .trim()
  .max(REPLAY_NOTE_MAX_LENGTH, `Keep the note under ${REPLAY_NOTE_MAX_LENGTH} characters`);

export const replaySchema = z.object({
  id: z.string().min(1),
  run_id: z.string().min(1),
  target_id: z.string().min(1),
  source_name: z.string(),
  records_total: z.number().int().min(0),
  cases_created: z.number().int().min(0),
  cases_rejected: z.number().int().min(0),
  status: runStatusSchema,
  created_at: z.string(),
}) satisfies z.ZodType<Replay>;

export const replayPageCodec = createSearchParamsCodec({
  target_id: targetIdParam(),
  replay_id: uuidParam(),
});

export const replayRecordFiltersCodec = createSearchParamsCodec({
  status: enumListParam(REPLAY_RECORD_STATUSES),
  reason_code: enumListParam(REPLAY_REASON_CODES),
});

export type ReplayRecordFilterValues = ReturnType<typeof replayRecordFiltersCodec.parse>;
