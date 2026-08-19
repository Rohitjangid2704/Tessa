import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkEnv, parseEnvText } from "./check-env.mjs";

const examplePath = path.resolve(import.meta.dirname, "../.env.example");

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "check-env-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeExample(text: string) {
  writeFileSync(path.join(root, ".env.example"), text);
}

function writeEnvFile(name: string, text: string) {
  writeFileSync(path.join(root, name), text);
}

describe("parseEnvText", () => {
  it("separates assigned keys from commented-out keys and ignores plain comments", () => {
    const parsed = parseEnvText(
      ["API_A=1", "export API_B=2", "# AUTH_C=true", "# just a note", "", "lower_case=1"].join(
        "\n",
      ),
    );
    expect(parsed.assigned).toEqual(["API_A", "API_B", "lower_case"]);
    expect(parsed.commented).toEqual(["AUTH_C"]);
  });
});

describe("checkEnv", () => {
  it("accepts the repository .env.example on its own", () => {
    copyFileSync(examplePath, path.join(root, ".env.example"));
    const { errors, notes } = checkEnv({ root });
    expect(errors).toEqual([]);
    expect(notes).toHaveLength(1);
  });

  it("fails when .env.example is missing", () => {
    expect(checkEnv({ root }).errors).toEqual([".env.example is missing"]);
  });

  it("fails on duplicate keys and keys outside the checked prefixes in .env.example", () => {
    writeExample("API_A=1\nAPI_A=2\nOTHER=3\n");
    const { errors } = checkEnv({ root });
    expect(errors).toContain(".env.example: duplicate key API_A");
    expect(errors.some((error) => error.includes("OTHER"))).toBe(true);
  });

  it("fails on unknown checked-prefix keys in any .env file and ignores unrelated keys", () => {
    writeExample("API_A=1\n");
    writeEnvFile(
      ".env.local",
      "API_A=1\nAPI_UNKNOWN=2\nAUTH_UNKNOWN=3\nE2E_UNKNOWN=4\nPATH_LIKE=5\n",
    );
    const { errors } = checkEnv({ root });
    expect(errors).toEqual([
      ".env.local: unknown key API_UNKNOWN (not in .env.example)",
      ".env.local: unknown key AUTH_UNKNOWN (not in .env.example)",
      ".env.local: unknown key E2E_UNKNOWN (not in .env.example)",
    ]);
  });

  it("fails on required keys missing from every .env file", () => {
    writeExample("API_A=1\nAPI_B=2\n");
    writeEnvFile(".env.local", "API_A=1\n");
    expect(checkEnv({ root }).errors).toEqual([
      "missing required key API_B (set it in .env.local)",
    ]);
  });

  it("accepts a required key supplied by the process environment", () => {
    writeExample("API_A=1\nAPI_B=2\n");
    writeEnvFile(".env.local", "API_A=1\n");
    expect(checkEnv({ root, processEnv: { API_B: "2" } }).errors).toEqual([]);
  });

  it("does not require commented-out optional keys or E2E_ keys", () => {
    writeExample("API_A=1\n# AUTH_TRUST_HOST=true\nE2E_BASE_URL=http://localhost:3000\n");
    writeEnvFile(".env.local", "API_A=1\n");
    expect(checkEnv({ root }).errors).toEqual([]);
  });

  it("accepts an optional key that is commented out in .env.example when set in an env file", () => {
    writeExample("API_A=1\n# AUTH_TRUST_HOST=true\n");
    writeEnvFile(".env.production", "API_A=1\nAUTH_TRUST_HOST=true\n");
    expect(checkEnv({ root }).errors).toEqual([]);
  });
});
