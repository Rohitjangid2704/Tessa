import { formatBytes } from "@/lib/format-bytes";

export interface FileDropRules {
  extensions: readonly string[];
  maxBytes: number | null;
}

export type FileRejection =
  | { reason: "multiple"; count: number }
  | { reason: "directory" }
  | { reason: "wrong_type"; fileName: string }
  | { reason: "empty"; fileName: string }
  | { reason: "too_large"; fileName: string; sizeBytes: number; maxBytes: number };

export type PickedFile = { file: File; rejection: null } | { file: null; rejection: FileRejection };

export function hasAllowedExtension(fileName: string, extensions: readonly string[]): boolean {
  const lowered = fileName.toLowerCase();
  return extensions.some((extension) => lowered.endsWith(extension.toLowerCase()));
}

export function validateFile(file: File, rules: FileDropRules): FileRejection | null {
  if (!hasAllowedExtension(file.name, rules.extensions)) {
    return { reason: "wrong_type", fileName: file.name };
  }
  if (file.size === 0) {
    return { reason: "empty", fileName: file.name };
  }
  if (rules.maxBytes !== null && file.size > rules.maxBytes) {
    return {
      reason: "too_large",
      fileName: file.name,
      sizeBytes: file.size,
      maxBytes: rules.maxBytes,
    };
  }
  return null;
}

export function pickFile(files: ArrayLike<File>, rules: FileDropRules): PickedFile {
  if (files.length > 1) {
    return { file: null, rejection: { reason: "multiple", count: files.length } };
  }
  const only = files[0];
  if (only === undefined) {
    return { file: null, rejection: { reason: "empty", fileName: "" } };
  }
  const rejection = validateFile(only, rules);
  return rejection === null ? { file: only, rejection: null } : { file: null, rejection };
}

export function describeRejection(rejection: FileRejection, rules: FileDropRules): string {
  const allowed = rules.extensions.join(", ");
  switch (rejection.reason) {
    case "multiple":
      return `Drop one file at a time (${rejection.count} were given).`;
    case "directory":
      return "Folders cannot be uploaded directly. Zip the folder first, then choose the zip.";
    case "wrong_type":
      return `${rejection.fileName} is not a ${allowed} file. Only ${allowed} files are accepted.`;
    case "empty":
      return rejection.fileName === ""
        ? "No file was chosen."
        : `${rejection.fileName} is empty (0 bytes).`;
    case "too_large":
      return `${rejection.fileName} is ${formatBytes(rejection.sizeBytes)}; the server accepts at most ${formatBytes(rejection.maxBytes)}.`;
  }
}
