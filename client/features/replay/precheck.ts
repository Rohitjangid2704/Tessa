import {
  createReplayFileSchema,
  REPLAY_HEAD_BYTES,
  REPLAY_HEAD_RECORDS,
  REPLAY_WHOLE_FILE_PARSE_BYTES,
  replayRecordHeadSchema,
} from "./schemas";

export type ReplayFormat = "jsonl" | "json";

export type ReplayPreCheck =
  | { ok: true; format: ReplayFormat; checkedRecords: number; fullyChecked: boolean }
  | { ok: false; problems: string[] };

function formatOf(fileName: string): ReplayFormat {
  return fileName.toLowerCase().endsWith(".json") ? "json" : "jsonl";
}

function isInvalidRecord(value: unknown): boolean {
  return !replayRecordHeadSchema.safeParse(value).success;
}

function checkRecords(values: readonly unknown[]): string[] {
  const problems: string[] = [];
  values.slice(0, REPLAY_HEAD_RECORDS).forEach((value, index) => {
    if (isInvalidRecord(value)) {
      problems.push(`Record ${index + 1} has no conversation_id or no messages.`);
    }
  });
  return problems;
}

async function checkJsonLines(file: File): Promise<ReplayPreCheck> {
  const head = await file.slice(0, REPLAY_HEAD_BYTES).text();
  const lines = head.split(/\r?\n/).filter((line) => line.trim() !== "");
  const complete = file.size > REPLAY_HEAD_BYTES ? lines.slice(0, -1) : lines;
  const values: unknown[] = [];
  const problems: string[] = [];
  complete.slice(0, REPLAY_HEAD_RECORDS).forEach((line, index) => {
    try {
      values.push(JSON.parse(line));
    } catch {
      problems.push(`Line ${index + 1} is not valid JSON.`);
    }
  });
  problems.push(...checkRecords(values));
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    format: "jsonl",
    checkedRecords: values.length,
    fullyChecked: values.length > 0 && values.length < REPLAY_HEAD_RECORDS && file.size <= REPLAY_HEAD_BYTES,
  };
}

function recordsOfJson(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (typeof parsed === "object" && parsed !== null) {
    const records: unknown = Reflect.get(parsed, "records");
    return Array.isArray(records) ? records : [parsed];
  }
  return [];
}

async function checkJson(file: File): Promise<ReplayPreCheck> {
  if (file.size > REPLAY_WHOLE_FILE_PARSE_BYTES) {
    const start = (await file.slice(0, 64).text()).trimStart();
    if (start.startsWith("[") || start.startsWith("{")) {
      return { ok: true, format: "json", checkedRecords: 0, fullyChecked: false };
    }
    return { ok: false, problems: ["The file does not start like a JSON array or object."] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return { ok: false, problems: ["The file is not valid JSON."] };
  }
  const records = recordsOfJson(parsed);
  if (records.length === 0) {
    return { ok: false, problems: ["The file holds no records."] };
  }
  const problems = checkRecords(records);
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    format: "json",
    checkedRecords: Math.min(records.length, REPLAY_HEAD_RECORDS),
    fullyChecked: records.length <= REPLAY_HEAD_RECORDS,
  };
}

export async function checkReplayFile(file: File, maxBytes: number | null): Promise<ReplayPreCheck> {
  const shape = createReplayFileSchema(maxBytes).safeParse({ name: file.name, size: file.size });
  if (!shape.success) {
    return { ok: false, problems: shape.error.issues.map((issue) => issue.message) };
  }
  return formatOf(file.name) === "json" ? checkJson(file) : checkJsonLines(file);
}
