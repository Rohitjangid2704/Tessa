import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { zipSync } from "fflate";
import { parse } from "yaml";
import { localError } from "./errors";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 2000;
export type ZipLimits = {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
};

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxFileBytes: MAX_FILE_BYTES,
  maxTotalBytes: MAX_TOTAL_BYTES,
  maxFiles: MAX_FILES,
};

export const BUNDLE_FOLDER = "tessa";
export const MANIFEST_NAME = "manifest.yaml";

const EXCLUDED_DIRECTORIES = new Set(["node_modules", "__pycache__"]);
const READ_BATCH_SIZE = 64;
const FIXED_TIMESTAMP = new Date(1980, 0, 1, 0, 0, 0);

export type ZippedBundle = {
  bytes: Uint8Array;
  fileCount: number;
  uncompressedBytes: number;
  files: string[];
  excluded: string[];
  targetToken: string | null;
  folder: string;
};

type CollectedFile = {
  archivePath: string;
  diskPath: string;
  size: number;
};

function isExcludedName(name: string): boolean {
  return name.startsWith(".") || EXCLUDED_DIRECTORIES.has(name);
}

async function pathKind(path: string): Promise<"file" | "directory" | "symlink" | "missing" | "other"> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      return "symlink";
    }
    if (info.isDirectory()) {
      return "directory";
    }
    return info.isFile() ? "file" : "other";
  } catch {
    return "missing";
  }
}

export async function resolveBundleFolder(input: string): Promise<string> {
  const given = resolve(input);
  const candidates = [given, join(given, BUNDLE_FOLDER)];
  for (const candidate of candidates) {
    if ((await pathKind(candidate)) === "directory" && (await pathKind(join(candidate, MANIFEST_NAME))) === "file") {
      return candidate;
    }
  }
  throw localError(
    "bundle_folder_not_found",
    `No ${BUNDLE_FOLDER}/${MANIFEST_NAME} found at ${input}; pass the repository folder or the ${BUNDLE_FOLDER} folder`,
  );
}

async function collectFiles(
  folder: string,
  limits: ZipLimits,
): Promise<{ files: CollectedFile[]; excluded: string[] }> {
  const collected: CollectedFile[] = [];
  const excluded: string[] = [];

  async function visit(directory: string, archivePrefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const name = entry.name;
      const diskPath = join(directory, name);
      const archivePath = `${archivePrefix}/${name}`;
      if (isExcludedName(name)) {
        excluded.push(archivePath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw localError("symlink_refused", `${archivePath} is a symbolic link; bundles may not contain links`);
      }
      if (entry.isDirectory()) {
        await visit(diskPath, archivePath);
        continue;
      }
      if (!entry.isFile()) {
        throw localError("unsupported_entry", `${archivePath} is not a regular file`);
      }
      const size = (await lstat(diskPath)).size;
      if (size > limits.maxFileBytes) {
        throw localError("file_too_large", `${archivePath} is larger than ${limits.maxFileBytes} bytes`);
      }
      collected.push({ archivePath, diskPath, size });
      if (collected.length > limits.maxFiles) {
        throw localError("too_many_files", `The bundle has more than ${limits.maxFiles} files`);
      }
    }
  }

  await visit(folder, BUNDLE_FOLDER);
  collected.sort((left, right) => (left.archivePath < right.archivePath ? -1 : 1));
  excluded.sort();
  return { files: collected, excluded };
}

async function readAll(files: CollectedFile[]): Promise<Uint8Array[]> {
  const contents: Uint8Array[] = [];
  for (let start = 0; start < files.length; start += READ_BATCH_SIZE) {
    const batch = files.slice(start, start + READ_BATCH_SIZE);
    contents.push(...(await Promise.all(batch.map(async (file) => new Uint8Array(await readFile(file.diskPath))))));
  }
  return contents;
}

function readTargetToken(manifestBytes: Uint8Array): string | null {
  try {
    const parsed: unknown = parse(Buffer.from(manifestBytes).toString("utf8"));
    if (typeof parsed === "object" && parsed !== null && "target_token" in parsed) {
      const token = (parsed as { target_token: unknown }).target_token;
      return typeof token === "string" && token.length > 0 ? token : null;
    }
  } catch {
    return null;
  }
  return null;
}

export async function zipBundleFolder(
  input: string,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Promise<ZippedBundle> {
  const folder = await resolveBundleFolder(input);
  const { files: collected, excluded } = await collectFiles(folder, limits);
  const totalBytes = collected.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > limits.maxTotalBytes) {
    throw localError("bundle_too_large", `The bundle is larger than ${limits.maxTotalBytes} bytes`);
  }

  const contents = await readAll(collected);
  const entries: Record<string, [Uint8Array, { level: 6; mtime: Date }]> = {};
  let targetToken: string | null = null;
  collected.forEach((file, index) => {
    const content = contents[index] as Uint8Array;
    entries[file.archivePath] = [content, { level: 6, mtime: FIXED_TIMESTAMP }];
    if (file.archivePath === `${BUNDLE_FOLDER}/${MANIFEST_NAME}`) {
      targetToken = readTargetToken(content);
    }
  });

  return {
    bytes: zipSync(entries),
    fileCount: collected.length,
    uncompressedBytes: totalBytes,
    files: collected.map((file) => file.archivePath),
    excluded,
    targetToken,
    folder,
  };
}
