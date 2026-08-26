import path from "node:path";

export type E2eStack = "mocked" | "real";

const AUTH_DIRECTORY = path.join("test-results", "auth");

export const SIGNED_OUT_STORAGE_STATE = { cookies: [], origins: [] };

export function authStatePath(stack: E2eStack): string {
  return path.join(AUTH_DIRECTORY, `${stack}.json`);
}
