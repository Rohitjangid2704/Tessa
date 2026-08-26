import { execFileSync } from "node:child_process";
import path from "node:path";
import { readE2eEnv } from "../../helpers/env";

const LOG_FILE_SEPARATOR = ",";
const COMMAND_TIMEOUT_MS = 120_000;
const NO_STDIN: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];

export const REPOSITORY_ROOT = path.resolve(process.cwd(), "..");
export const API_ROOT = path.join(REPOSITORY_ROOT, "api");
export const COMPOSE_FILE = path.join(REPOSITORY_ROOT, "deploy", "docker-compose.yml");
export const DEFAULT_FIXTURE_DIRECTORY = path.join(API_ROOT, "tests", "fixtures", "bundles", "out");

export const VIEWER_CREDENTIALS = {
  email: "viewer@tessa.local",
  password: "dev-only-viewer-password-1",
};

export function apiDataDirectory(): string {
  return readE2eEnv().E2E_API_DATA_DIR ?? path.join(API_ROOT, "data");
}

export function serverLogFiles(): string[] {
  const configured = readE2eEnv().E2E_LOG_FILES;
  if (configured === undefined) {
    return [];
  }
  return configured
    .split(LOG_FILE_SEPARATOR)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

export function runCommand(command: string, args: string[], cwd: string, input?: string): string {
  return execFileSync(command, args, {
    cwd,
    input,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    stdio: input === undefined ? NO_STDIN : ["pipe", "pipe", "pipe"],
  });
}
