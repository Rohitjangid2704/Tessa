import { ApiError, describeApiError, isApiError, TOKEN_UNAVAILABLE_CODE } from "@/lib/api/errors";

export type UploadFailureKind =
  | "secret_found"
  | "too_large"
  | "unsupported_media"
  | "token_mismatch"
  | "token_unknown"
  | "archive_rejected"
  | "idempotency_conflict"
  | "forbidden"
  | "target_archived"
  | "target_missing"
  | "rate_limited"
  | "unavailable"
  | "network"
  | "session"
  | "rejected"
  | "unknown";

export interface SecretFinding {
  file: string;
  line: number | null;
  pattern: string;
  excerpt: string;
}

export interface UploadProblem {
  code: string;
  message: string;
  path: string | null;
}

export interface UploadFailure {
  kind: UploadFailureKind;
  code: string;
  title: string;
  message: string;
  nextStep: string | null;
  retryable: boolean;
  requestId: string | null;
  findings: SecretFinding[];
  problems: UploadProblem[];
}

export const TOO_LARGE_CODES = [
  "body_too_large",
  "archive_too_large",
  "too_many_entries",
  "entry_too_large",
  "expanded_too_large",
  "compression_ratio_exceeded",
  "manifest_too_large",
] as const;

export const ARCHIVE_REJECTION_CODES = [
  "unsafe_path",
  "symlink_entry",
  "encrypted_entry",
  "duplicate_entry",
  "invalid_archive",
  "manifest_missing",
  "unsupported_compression",
] as const;

type TooLargeCode = (typeof TOO_LARGE_CODES)[number];
type ArchiveRejectionCode = (typeof ARCHIVE_REJECTION_CODES)[number];

interface Wording {
  title: string;
  nextStep: string;
}

const TOO_LARGE_WORDING: Record<TooLargeCode, Wording> = {
  body_too_large: {
    title: "The upload is larger than the server accepts",
    nextStep: "Zip only the tessa folder and leave build output and large assets out.",
  },
  archive_too_large: {
    title: "The zip is larger than the server accepts",
    nextStep: "Zip only the tessa folder and leave build output and large assets out.",
  },
  too_many_entries: {
    title: "The zip has too many files",
    nextStep: "Zip only the tessa folder, not the whole repository.",
  },
  entry_too_large: {
    title: "A file inside the zip is too large",
    nextStep: "Remove or shrink that file; a bundle holds text files only.",
  },
  expanded_too_large: {
    title: "The zip expands to more than the server accepts",
    nextStep: "Remove large files from the tessa folder and zip again.",
  },
  compression_ratio_exceeded: {
    title: "A file inside the zip is compressed suspiciously well",
    nextStep: "Replace that file with its real text content and zip again.",
  },
  manifest_too_large: {
    title: "manifest.yaml is too large",
    nextStep: "Split large data out of the manifest or shorten it.",
  },
};

const ARCHIVE_REJECTION_WORDING: Record<ArchiveRejectionCode, Wording> = {
  unsafe_path: {
    title: "The zip contains an unsafe path",
    nextStep: "Zip the tessa folder itself; paths must be relative and stay inside it.",
  },
  symlink_entry: {
    title: "The zip contains a symbolic link",
    nextStep: "Replace the link with a real file and zip again.",
  },
  encrypted_entry: {
    title: "The zip contains an encrypted file",
    nextStep: "Create the zip without a password.",
  },
  duplicate_entry: {
    title: "The zip contains two files with the same path",
    nextStep: "Rename or remove one of them; paths are compared without case.",
  },
  invalid_archive: {
    title: "The file is not a readable zip",
    nextStep:
      "Create the zip again, for example with Compress-Archive -Path tessa -DestinationPath tessa.zip.",
  },
  manifest_missing: {
    title: "The zip has no manifest.yaml",
    nextStep: "Put manifest.yaml at the root of the zip or directly inside a Tessa folder.",
  },
  unsupported_compression: {
    title: "A file uses an unsupported compression method",
    nextStep: "Create the zip again with the standard deflate method.",
  },
};

function isTooLargeCode(code: string): code is TooLargeCode {
  return (TOO_LARGE_CODES as readonly string[]).includes(code);
}

function isArchiveRejectionCode(code: string): code is ArchiveRejectionCode {
  return (ARCHIVE_REJECTION_CODES as readonly string[]).includes(code);
}

function pathOf(detail: { loc: ReadonlyArray<string | number> }): string | null {
  const [scope, path] = detail.loc;
  return scope === "file" && typeof path === "string" ? path : null;
}

function lineOf(detail: { loc: ReadonlyArray<string | number> }): number | null {
  const line = detail.loc[2];
  return typeof line === "number" ? line : null;
}

function secretFindings(error: ApiError): SecretFinding[] {
  return error.details.map((detail) => ({
    file: pathOf(detail) ?? "unknown file",
    line: lineOf(detail),
    pattern: detail.code,
    excerpt: detail.message,
  }));
}

function problemsOf(error: ApiError): UploadProblem[] {
  return error.details.map((detail) => ({
    code: detail.code,
    message: detail.message,
    path: pathOf(detail),
  }));
}

function build(
  error: ApiError,
  kind: UploadFailureKind,
  wording: { title: string; message?: string; nextStep?: string | null },
  extra: Partial<Pick<UploadFailure, "retryable" | "findings" | "problems" | "code">> = {},
): UploadFailure {
  return {
    kind,
    code: extra.code ?? error.code,
    title: wording.title,
    message: wording.message ?? error.message,
    nextStep: wording.nextStep ?? null,
    retryable: extra.retryable ?? false,
    requestId: error.requestId,
    findings: extra.findings ?? [],
    problems: extra.problems ?? [],
  };
}

function describePayloadTooLarge(error: ApiError): UploadFailure {
  const detailCode = error.details[0]?.code ?? "";
  const known = isTooLargeCode(detailCode) ? TOO_LARGE_WORDING[detailCode] : null;
  const path = error.details[0] === undefined ? null : pathOf(error.details[0]);
  const wording = known ?? {
    title: "The upload is larger than the server accepts",
    nextStep: "Zip only the tessa folder and leave build output and large assets out.",
  };
  return build(
    error,
    "too_large",
    {
      ...wording,
      message: path === null ? error.message : `${error.message} (${path})`,
    },
    { code: detailCode === "" ? error.code : detailCode, problems: problemsOf(error) },
  );
}

function describeValidationFailed(error: ApiError): UploadFailure {
  const detailCode = error.details[0]?.code ?? "";
  if (isArchiveRejectionCode(detailCode)) {
    return build(error, "archive_rejected", ARCHIVE_REJECTION_WORDING[detailCode], {
      code: detailCode,
      problems: problemsOf(error),
    });
  }
  return build(
    error,
    "rejected",
    {
      title: "The server rejected the upload",
      nextStep: "Fix the problems listed below and try again.",
    },
    { code: detailCode === "" ? error.code : detailCode, problems: problemsOf(error) },
  );
}

function describeConflict(error: ApiError): UploadFailure {
  if (error.code === "target_token_mismatch") {
    return build(error, "token_mismatch", {
      title: "This bundle belongs to a different target",
      nextStep:
        "Open the target the bundle was made for, or copy the Discovery prompt of this target and generate the bundle again.",
    });
  }
  if (error.code === "idempotency_conflict") {
    return build(error, "idempotency_conflict", {
      title: "This request key was already used for different content",
      nextStep: "Choose the file again to start a new upload.",
    });
  }
  return build(error, "target_archived", {
    title: "This target cannot accept bundles",
    nextStep: "Archived targets are read-only.",
  });
}

function describeServerError(error: ApiError): UploadFailure {
  return build(
    error,
    "unavailable",
    {
      title: "The Tessa API could not process the upload",
      message: describeApiError(error),
      nextStep: "Nothing was stored. Try again in a moment.",
    },
    { retryable: true },
  );
}

export function describeUploadFailure(error: unknown): UploadFailure {
  if (!isApiError(error)) {
    return {
      kind: "unknown",
      code: "unknown",
      title: "The upload failed",
      message: error instanceof Error && error.message ? error.message : "Something went wrong",
      nextStep: null,
      retryable: true,
      requestId: null,
      findings: [],
      problems: [],
    };
  }
  if (error.isNetworkError) {
    return build(
      error,
      "network",
      {
        title: "Cannot reach the Tessa API",
        message: describeApiError(error),
        nextStep:
          "It is not known whether the upload reached the API. Check that the API is running and try again: the retry reuses the same request key, so it never creates a duplicate version.",
      },
      { retryable: true },
    );
  }
  if (error.code === TOKEN_UNAVAILABLE_CODE) {
    return build(
      error,
      "session",
      {
        title: "Could not get an API token",
        nextStep: "Reload the page or sign in again, then retry.",
      },
      { retryable: true },
    );
  }
  switch (error.status) {
    case 403:
      return build(error, "forbidden", {
        title: "Your role cannot upload bundles",
        nextStep: "Ask a member or an admin to upload it.",
      });
    case 404:
      return build(error, "target_missing", {
        title: "The target was not found",
        nextStep: "It may have been removed. Go back to the targets list.",
      });
    case 409:
      return describeConflict(error);
    case 413:
      return describePayloadTooLarge(error);
    case 415:
      return build(error, "unsupported_media", {
        title: "The file is not accepted as a zip",
        nextStep: "Choose a .zip file made from the tessa folder.",
      });
    case 422:
      if (error.code === "bundle_contains_secret") {
        return build(
          error,
          "secret_found",
          {
            title: "The bundle contains what look like secrets",
            nextStep:
              "Nothing was stored. Keep real values out of the bundle: use a ${NAME} placeholder, declare it in env.template, enter the value on the Environment page, then upload again.",
          },
          { findings: secretFindings(error) },
        );
      }
      if (error.code === "target_token_unknown") {
        return build(error, "token_unknown", {
          title: "The target token in manifest.yaml is not known",
          nextStep:
            "Copy the target_token from the Discovery or Fix-up prompt of this target into manifest.yaml.",
        });
      }
      return describeValidationFailed(error);
    case 429:
      return build(
        error,
        "rate_limited",
        {
          title: "Too many requests",
          message: describeApiError(error),
          nextStep: "Wait a moment and try again.",
        },
        { retryable: true },
      );
    default:
      break;
  }
  if (error.isServerError) {
    return describeServerError(error);
  }
  return build(error, "unknown", {
    title: "The upload failed",
    nextStep: null,
  });
}
