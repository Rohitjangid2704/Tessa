import { classifyStartError, type StartProblem } from "@/features/runs/start-errors";
import { describeApiError, isApiError } from "@/lib/api/errors";
import { UNEXPECTED_BODY_CODE } from "@/lib/api/upload";

export interface ReplayUploadFailure extends StartProblem {
  retryable: boolean;
  nextStep: string | null;
}

const UNPARSEABLE_NEXT_STEP =
  "Export the conversations again as JSON lines, one object per line with a conversation_id and a messages list.";

export function describeReplayUploadFailure(error: unknown): ReplayUploadFailure {
  const problem = classifyStartError(error, "blocked");
  if (!isApiError(error)) {
    return { ...problem, retryable: true, nextStep: null };
  }
  if (error.isNetworkError) {
    return {
      ...problem,
      kind: "unavailable",
      title: "Cannot reach the Tessa API",
      message: describeApiError(error),
      retryable: true,
      nextStep:
        "It is not known whether the upload arrived. Try again: the retry reuses the same request key, so it never creates a second replay.",
    };
  }
  if (error.code === UNEXPECTED_BODY_CODE) {
    return {
      ...problem,
      title: "The upload was accepted but the answer was not understood",
      message: "Open the replay list to see whether it was created.",
      retryable: false,
      nextStep: null,
    };
  }
  switch (error.status) {
    case 413:
      return {
        ...problem,
        kind: "too_large",
        title: "The export is larger than the server accepts",
        message: error.message,
        retryable: false,
        nextStep: "Split the export into smaller files and upload them one by one.",
      };
    case 415:
      return {
        ...problem,
        kind: "invalid",
        title: "The file is not accepted as an export",
        message: "Only .jsonl and .json production exports are accepted.",
        retryable: false,
        nextStep: null,
      };
    case 422:
      return {
        ...problem,
        title: "The server could not read the export",
        retryable: false,
        nextStep: UNPARSEABLE_NEXT_STEP,
      };
    case 409:
      return {
        ...problem,
        retryable: false,
        nextStep:
          problem.kind === "production_blocked"
            ? null
            : "Choose the file again to start a new upload.",
      };
    default:
      return {
        ...problem,
        retryable: error.isServerError || error.status === 429,
        nextStep: null,
      };
  }
}
