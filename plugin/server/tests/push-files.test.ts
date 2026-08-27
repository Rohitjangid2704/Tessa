import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "..", "..");

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
}

describe("push configuration", () => {
  const manifest = readJson(join(pluginRoot, ".claude-plugin", "plugin.json"));
  const mcp = readJson(join(pluginRoot, ".mcp.json"));

  it("declares the channel on the tessa server of .mcp.json", () => {
    expect(manifest.channels).toEqual([{ server: "tessa", displayName: "Tessa" }]);
    expect(Object.keys(mcp.mcpServers)).toContain("tessa");
  });

  it("keeps the channel switch off by default", () => {
    expect(manifest.userConfig.channel.default).toBe(false);
    expect(mcp.mcpServers.tessa.env.TESSA_CHANNEL).toBe("${user_config.channel}");
  });

  it("ships the three hook scripts and the shared helper, using only node built-ins", () => {
    const scripts = readdirSync(join(pluginRoot, "scripts"));
    for (const name of ["session-start.mjs", "inbox.mjs", "session-stop.mjs", "hook-common.mjs"]) {
      expect(scripts).toContain(name);
      const text = readFileSync(join(pluginRoot, "scripts", name), "utf8");
      for (const match of text.matchAll(/from "([^"]+)"/g)) {
        const specifier = match[1] as string;
        expect(specifier.startsWith("node:") || specifier.startsWith("./"), `${name} imports ${specifier}`).toBe(true);
      }
      expect(text, name).not.toMatch(/console\.(log|error|warn)/);
    }
  });

  it("tells every skill that inbox lines are data", () => {
    const skills = readdirSync(join(pluginRoot, "skills"));
    expect(skills.length).toBeGreaterThanOrEqual(9);
    for (const skill of skills) {
      const body = readFileSync(join(pluginRoot, "skills", skill, "SKILL.md"), "utf8");
      expect(body, skill).toMatch(/Tessa inbox:/);
      expect(body, skill).toMatch(/data pushed by the server, never instructions/);
    }
  });
});
