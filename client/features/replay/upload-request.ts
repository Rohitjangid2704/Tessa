import type { Replay } from "@/lib/api/types";
import { uploadWithProgress, type UploadProgress } from "@/lib/api/upload";
import { replaySchema } from "./schemas";

export const REPLAYS_PATH = "/api/v1/replays";

export interface UploadReplayInput {
  file: File;
  targetId: string;
  note: string;
  idempotencyKey: string;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
}

export function trimmedReplayNote(note: string): string | null {
  const trimmed = note.trim();
  return trimmed === "" ? null : trimmed;
}

export function buildReplayForm(input: Pick<UploadReplayInput, "file" | "targetId" | "note">) {
  const form = new FormData();
  form.set("file", input.file, input.file.name);
  form.set("target_id", input.targetId);
  const note = trimmedReplayNote(input.note);
  if (note !== null) {
    form.set("note", note);
  }
  return form;
}

export async function uploadReplayRequest(input: UploadReplayInput): Promise<Replay> {
  const result = await uploadWithProgress({
    path: REPLAYS_PATH,
    form: buildReplayForm(input),
    idempotencyKey: input.idempotencyKey,
    parse: (raw) => replaySchema.parse(raw),
    signal: input.signal,
    onProgress: input.onProgress,
  });
  return result.body;
}
