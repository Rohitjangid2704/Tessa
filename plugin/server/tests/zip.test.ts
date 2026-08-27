import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/errors";
import { DEFAULT_ZIP_LIMITS, resolveBundleFolder, zipBundleFolder } from "../src/zip";

const MANIFEST_TEXT = `schema: x
target_token: tgt_demo12345678
app:
  name: Demo
`;

let root: string;
let folder: string;

async function put(relative: string, content: string | Uint8Array): Promise<void> {
  const target = join(folder, relative);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content);
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("expected a rejection");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tessa-zip-"));
  folder = join(root, "tessa");
  await mkdir(folder);
  await put("manifest.yaml", MANIFEST_TEXT);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("zipBundleFolder", () => {
  it("zips the tessa folder under the tessa prefix", async () => {
    await put("scenarios/a.yaml", "id: a\n");
    await put("env.template", "A=\n");
    const zipped = await zipBundleFolder(root);
    const entries = Object.keys(unzipSync(zipped.bytes));
    expect(entries).toEqual(["tessa/env.template", "tessa/manifest.yaml", "tessa/scenarios/a.yaml"]);
    expect(zipped.fileCount).toBe(3);
    expect(zipped.targetToken).toBe("tgt_demo12345678");
  });

  it("accepts the tessa folder itself", async () => {
    const zipped = await zipBundleFolder(folder);
    expect(zipped.files).toEqual(["tessa/manifest.yaml"]);
  });

  it("leaves out .git, node_modules, __pycache__ and dotfiles", async () => {
    await put(".git/config", "x");
    await put("node_modules/pkg/index.js", "x");
    await put("scenarios/__pycache__/a.pyc", "x");
    await put(".env", "SECRET=1");
    await put("scenarios/.hidden.yaml", "x");
    await put("scenarios/a.yaml", "id: a\n");
    const zipped = await zipBundleFolder(root);
    expect(zipped.files).toEqual(["tessa/manifest.yaml", "tessa/scenarios/a.yaml"]);
    expect(zipped.excluded).toEqual([
      "tessa/.env",
      "tessa/.git",
      "tessa/node_modules",
      "tessa/scenarios/.hidden.yaml",
      "tessa/scenarios/__pycache__",
    ]);
  });

  it("is deterministic whatever the creation order", async () => {
    await put("z.yaml", "z");
    await put("a.yaml", "a");
    await put("m/b.yaml", "b");
    const first = await zipBundleFolder(root);
    const second = await zipBundleFolder(root);
    expect(createHash("sha256").update(first.bytes).digest("hex")).toBe(
      createHash("sha256").update(second.bytes).digest("hex"),
    );
    expect(first.files).toEqual([...first.files].sort());
  });

  it("refuses a symbolic link or junction", async () => {
    await put("real/a.yaml", "x");
    await symlink(join(folder, "real"), join(folder, "linked"), "junction");
    const error = await rejection(zipBundleFolder(root));
    expect(error.code).toBe("symlink_refused");
  });

  it("uses the planned caps by default", () => {
    expect(DEFAULT_ZIP_LIMITS).toEqual({
      maxFileBytes: 5 * 1024 * 1024,
      maxTotalBytes: 25 * 1024 * 1024,
      maxFiles: 2000,
    });
  });

  it("refuses a file above the per-file cap and accepts one exactly at it", async () => {
    const limits = { maxFileBytes: 100, maxTotalBytes: 10_000, maxFiles: 50 };
    await put("edge.bin", new Uint8Array(100));
    const zipped = await zipBundleFolder(root, limits);
    expect(zipped.files).toContain("tessa/edge.bin");
    await put("big.bin", new Uint8Array(101));
    const error = await rejection(zipBundleFolder(root, limits));
    expect(error.code).toBe("file_too_large");
  });

  it("refuses a bundle above the total cap and accepts one exactly at it", async () => {
    const manifestBytes = Buffer.byteLength(MANIFEST_TEXT);
    const limits = { maxFileBytes: 1000, maxTotalBytes: manifestBytes + 200, maxFiles: 50 };
    await put("a.bin", new Uint8Array(100));
    await put("b.bin", new Uint8Array(100));
    const zipped = await zipBundleFolder(root, limits);
    expect(zipped.uncompressedBytes).toBe(limits.maxTotalBytes);
    await put("c.bin", new Uint8Array(1));
    const error = await rejection(zipBundleFolder(root, limits));
    expect(error.code).toBe("bundle_too_large");
  });

  it("refuses more files than the cap and accepts exactly the cap", async () => {
    const limits = { maxFileBytes: 1000, maxTotalBytes: 10_000, maxFiles: 4 };
    await put("f1.txt", "x");
    await put("f2.txt", "x");
    await put("f3.txt", "x");
    const zipped = await zipBundleFolder(root, limits);
    expect(zipped.fileCount).toBe(4);
    await put("f4.txt", "x");
    const error = await rejection(zipBundleFolder(root, limits));
    expect(error.code).toBe("too_many_files");
  });

  it("reports a missing manifest", async () => {
    const empty = await mkdtemp(join(tmpdir(), "tessa-empty-"));
    try {
      const error = await rejection(resolveBundleFolder(empty));
      expect(error.code).toBe("bundle_folder_not_found");
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("returns a null target token when the manifest has none", async () => {
    await put("manifest.yaml", "app:\n  name: Demo\n");
    const zipped = await zipBundleFolder(root);
    expect(zipped.targetToken).toBeNull();
  });
});
