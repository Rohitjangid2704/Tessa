import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseEnvText } from "./check-env.mjs";
import { clientEnvKeys, serverEnvKeys } from "../lib/env.schema";

const clientRoot = path.resolve(import.meta.dirname, "..");
const composePath = path.resolve(clientRoot, "..", "deploy", "docker-compose.yml");
const composeText = readFileSync(composePath, "utf8");
const dockerfileText = readFileSync(path.join(clientRoot, "Dockerfile"), "utf8");
const dockerignoreLines = readFileSync(path.join(clientRoot, ".dockerignore"), "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim());

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function childBlock(lines: readonly string[], header: string, parentIndent: number): string[] {
  const start = lines.findIndex(
    (line) => indentOf(line) === parentIndent && line.trim() === header,
  );
  if (start < 0) {
    return [];
  }
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && indentOf(line) <= parentIndent) {
      break;
    }
    block.push(line);
  }
  return block;
}

function mappingKeys(block: readonly string[]): string[] {
  const entries = block.filter((line) => line.trim() !== "");
  const childIndent = Math.min(...entries.map(indentOf));
  return entries
    .filter((line) => indentOf(line) === childIndent)
    .map((line) => line.trim().split(":")[0] ?? "");
}

const composeLines = composeText.split(/\r?\n/);
const webService = childBlock(composeLines, "web:", 2);
const webEnvironment = childBlock(webService, "environment:", 4);
const webBuildArgs = childBlock(childBlock(webService, "build:", 4), "args:", 6);
const exampleKeys = (() => {
  const { assigned, commented } = parseEnvText(
    readFileSync(path.join(clientRoot, ".env.example"), "utf8"),
  );
  return new Set([...assigned, ...commented]);
})();

describe("compose web service", () => {
  it("exists under the web profile only", () => {
    expect(webService.length).toBeGreaterThan(0);
    expect(webService.map((line) => line.trim())).toContain("profiles: [web]");
  });

  it("builds the client folder with its Dockerfile", () => {
    const joined = webService.join("\n");
    expect(joined).toMatch(/context: \.\.\/client/);
    expect(joined).toMatch(/dockerfile: Dockerfile/);
  });

  it("passes only the browser-visible keys as build args", () => {
    expect(mappingKeys(webBuildArgs)).toEqual(["NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_PLUGIN_SOURCE"]);
    expect(clientEnvKeys).toContain("NEXT_PUBLIC_API_URL");
    expect(clientEnvKeys).toContain("NEXT_PUBLIC_PLUGIN_SOURCE");
  });

  it("overrides only keys the client env schema and .env.example know", () => {
    const keys = mappingKeys(webEnvironment);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(serverEnvKeys, key).toContain(key);
      expect(exampleKeys.has(key), key).toBe(true);
    }
  });

  it("points the server at the api container and trusts the proxy host", () => {
    const environment = webEnvironment.map((line) => line.trim());
    expect(environment).toContain("API_INTERNAL_URL: http://api:8000");
    expect(environment).toContain('AUTH_TRUST_HOST: "true"');
  });

  it("reads secrets and the remaining keys from client/.env.local, never from the compose file", () => {
    expect(webService.join("\n")).toMatch(/path: \.\.\/client\/\.env\.local/);
    for (const secretKey of ["AUTH_SECRET", "API_JWT_SECRET", "API_SERVICE_KEY"]) {
      expect(mappingKeys(webEnvironment)).not.toContain(secretKey);
    }
    expect(webService.join("\n")).not.toContain("${");
  });
});

describe("client Dockerfile", () => {
  it("takes the browser-visible keys as build args and nothing else", () => {
    expect(dockerfileText.match(/^ARG (\w+)/gm)).toEqual([
      "ARG NODE_VERSION",
      "ARG NEXT_PUBLIC_API_URL",
      "ARG NEXT_PUBLIC_PLUGIN_SOURCE",
    ]);
  });

  it("runs the standalone server as a non-root user, not next start", () => {
    expect(dockerfileText).toMatch(/^CMD \["node", "server\.js"\]$/m);
    expect(dockerfileText).not.toMatch(/next start/);
    expect(dockerfileText).toMatch(/^USER tessa$/m);
    expect(dockerfileText).toContain("/app/.next/standalone");
    expect(dockerfileText).toContain("/app/.next/static");
  });

  it("keeps env files and build output out of the image context", () => {
    for (const entry of [".env*", "node_modules", ".next"]) {
      expect(dockerignoreLines).toContain(entry);
    }
  });
});
