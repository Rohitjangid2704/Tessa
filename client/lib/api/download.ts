import { apiBaseUrl, authedFetch } from "./client";
import { ApiError } from "./errors";

export const DEFAULT_DOWNLOAD_FILENAME = "download";

const MAX_FILENAME_LENGTH = 200;
const REVOKE_DELAY_MS = 10_000;
const EXTENDED_FILENAME = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i;
const QUOTED_FILENAME = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i;
const BARE_FILENAME = /filename\s*=\s*([^;"]+)/i;
const FIRST_PRINTABLE_CODE = 32;
const DELETE_CODE = 127;
const PATH_SEPARATORS = new Set(["/", "\\"]);

export interface DownloadedFile {
  blob: Blob;
  filename: string;
  contentType: string;
}

export interface FetchFileOptions {
  fallbackFilename?: string;
  accept?: string;
  signal?: AbortSignal;
}

function decodeExtendedValue(raw: string): string {
  try {
    return decodeURIComponent(raw.trim());
  } catch {
    return raw.trim();
  }
}

function isUnsafeFilenameCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return PATH_SEPARATORS.has(character) || code < FIRST_PRINTABLE_CODE || code === DELETE_CODE;
}

function sanitizeFilename(name: string): string {
  const cleaned = Array.from(name, (character) =>
    isUnsafeFilenameCharacter(character) ? "_" : character,
  )
    .join("")
    .trim();
  return cleaned.replace(/^\.+/, "").slice(0, MAX_FILENAME_LENGTH);
}

function rawFilename(header: string): string {
  const extended = EXTENDED_FILENAME.exec(header)?.[1];
  if (extended !== undefined) {
    return decodeExtendedValue(extended);
  }
  const quoted = QUOTED_FILENAME.exec(header)?.[1];
  if (quoted !== undefined) {
    return quoted.replace(/\\(.)/g, "$1");
  }
  return BARE_FILENAME.exec(header)?.[1] ?? "";
}

export function filenameFromContentDisposition(
  header: string | null,
  fallback: string = DEFAULT_DOWNLOAD_FILENAME,
): string {
  if (header === null) {
    return fallback;
  }
  const cleaned = sanitizeFilename(rawFilename(header));
  return cleaned === "" ? fallback : cleaned;
}

async function readErrorBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function fetchAuthedFile(
  path: string,
  options: FetchFileOptions = {},
): Promise<DownloadedFile> {
  const { fallbackFilename = DEFAULT_DOWNLOAD_FILENAME, accept = "*/*", signal } = options;
  const request = new Request(new URL(path, apiBaseUrl), { headers: { Accept: accept }, signal });
  const response = await authedFetch(request);
  if (!response.ok) {
    throw ApiError.fromResponse(response, await readErrorBody(response));
  }
  const blob = await response.blob();
  return {
    blob,
    filename: filenameFromContentDisposition(
      response.headers.get("content-disposition"),
      fallbackFilename,
    ),
    contentType: response.headers.get("content-type") ?? blob.type,
  };
}

export function saveDownloadedFile(file: DownloadedFile): void {
  const url = URL.createObjectURL(file.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.filename;
  anchor.rel = "noopener";
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

export async function downloadAuthedFile(
  path: string,
  options: FetchFileOptions = {},
): Promise<DownloadedFile> {
  const file = await fetchAuthedFile(path, options);
  saveDownloadedFile(file);
  return file;
}
