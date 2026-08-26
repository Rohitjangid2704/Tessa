import { mkdirSync } from "node:fs";
import path from "node:path";
import { API_ROOT, DEFAULT_FIXTURE_DIRECTORY, VIEWER_CREDENTIALS, runCommand } from "./stack";

export type BundleFixtureName =
  | "minimal_valid.zip"
  | "gracie_like.zip"
  | "gracie_like_changed.zip"
  | "missing_sections.zip"
  | "secret_bearing.zip"
  | "zip_slip.zip"
  | "backslash_paths.zip"
  | "zip_bomb.zip"
  | "paste_only.manifest.yaml";

export interface BuiltFixtures {
  directory: string;
  path: (name: BundleFixtureName) => string;
}

export function buildBundleFixtures(
  targetToken: string,
  requestedDirectory: string = DEFAULT_FIXTURE_DIRECTORY,
): BuiltFixtures {
  const directory = path.resolve(requestedDirectory);
  mkdirSync(directory, { recursive: true });
  runCommand(
    "uv",
    [
      "run",
      "python",
      "scripts/build_bundle_fixtures.py",
      "--target-token",
      targetToken,
      "--out-dir",
      directory,
    ],
    API_ROOT,
  );
  return { directory, path: (name) => path.join(directory, name) };
}

export function ensureViewerUser(): void {
  try {
    runCommand(
      "uv",
      [
        "run",
        "python",
        "scripts/create_user.py",
        "--email",
        VIEWER_CREDENTIALS.email,
        "--name",
        "E2E Viewer",
        "--role",
        "viewer",
        "--password-stdin",
      ],
      API_ROOT,
      `${VIEWER_CREDENTIALS.password}\n`,
    );
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    if (!stderr.includes("already exists")) {
      throw error;
    }
  }
}
