import type { ExplanationStructured } from "@/lib/api/types";
import { BodyReader } from "../stage1/body";

const OPINIONS = ["app_bug", "scenario_bug", "harness", "unknown"] as const;
const CONFIDENCES = ["low", "medium", "high"] as const;
const ROOT_CAUSE_MAX = 2000;
const FILES_MAX = 30;

function readFiles(structured: BodyReader, raw: unknown): ExplanationStructured["files"] {
  if (!Array.isArray(raw)) {
    structured.issue("files", "list_type", "Input should be a valid list");
    return [];
  }
  if (raw.length > FILES_MAX) {
    structured.issue(
      "files",
      "too_long",
      `List should have at most ${FILES_MAX} items after validation, not ${raw.length}`,
    );
    return [];
  }
  const files: ExplanationStructured["files"] = [];
  raw.forEach((entry: unknown, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      structured.issue(index, "dict_type", "Input should be a valid dictionary");
      return;
    }
    const reader = new BodyReader(Object.fromEntries(Object.entries(entry)), [
      "body",
      "structured",
      "files",
      index,
    ]);
    const path = reader.string("path", { required: true, min: 1 });
    const lines = reader.string("lines", { required: false, nullable: true });
    structured.details.push(...reader.details);
    if (typeof path === "string") {
      files.push({ path, lines: lines ?? null });
    }
  });
  return files;
}

export function readStructuredExplanation(
  body: BodyReader,
): ExplanationStructured | null | undefined {
  const source = body.object("structured", { nullable: true });
  if (source === undefined || source === null) {
    return source;
  }
  const reader = new BodyReader(source, ["body", "structured"]);
  const opinion = reader.enum("opinion", OPINIONS, { required: true });
  const rootCause = reader.string("root_cause", { required: true, min: 1, max: ROOT_CAUSE_MAX });
  const confidence = reader.enum("confidence", CONFIDENCES, { required: true });
  const commit = reader.string("commit", { required: false, nullable: true });
  const fixBranch = reader.string("fix_branch", { required: false, nullable: true });
  const files = reader.has("files") ? readFiles(reader, source.files) : [];
  if (!reader.has("files")) {
    reader.issue("files", "missing", "Field required");
  }
  body.details.push(...reader.details);
  if (
    typeof opinion !== "string" ||
    typeof rootCause !== "string" ||
    typeof confidence !== "string" ||
    reader.details.length > 0
  ) {
    return undefined;
  }
  return {
    opinion,
    root_cause: rootCause,
    files,
    commit: commit ?? null,
    fix_branch: fixBranch ?? null,
    confidence,
  };
}
