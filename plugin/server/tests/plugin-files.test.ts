import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/tools";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "..", "..");
const TOOL_PREFIX = "mcp__plugin_tessa_tessa__";
const SKILLS = ["connect", "discover", "run", "explain", "fix", "propose", "author", "mutants", "hooks"];
const RESULT_FIELDS = new Set(["issue_id"]);
const ALLOWED_BUILTINS = [/^Read$/, /^Grep$/, /^Glob$/, /^Bash\(git (rev-parse|branch|status|log|blame|show|diff|ls-files)\b[^)]*\)$/];

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
}

function frontmatterOf(path: string): Record<string, any> {
  const text = readFileSync(path, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (match === null) {
    throw new Error(`${path} has no frontmatter`);
  }
  return parse(match[1] as string) as Record<string, any>;
}

describe("plugin manifest and mcp config", () => {
  const manifest = readJson(join(pluginRoot, ".claude-plugin", "plugin.json"));
  const mcp = readJson(join(pluginRoot, ".mcp.json"));
  const server = readJson(join(pluginRoot, "server", "package.json"));

  it("names the plugin tessa and keeps the versions equal", () => {
    expect(manifest.name).toBe("tessa");
    expect(manifest.version).toBe(server.version);
  });

  it("asks for the url, the sensitive token, the watched targets and the channel in that order", () => {
    expect(Object.keys(manifest.userConfig)).toEqual(["api_url", "api_token", "watch_targets", "channel"]);
    expect(manifest.userConfig.api_token.sensitive).toBe(true);
    expect(manifest.userConfig.api_url.sensitive).toBeUndefined();
    expect(manifest.userConfig.watch_targets.multiple).toBe(true);
    expect(manifest.userConfig.channel.default).toBe(false);
  });

  it("starts the bundled server and passes the token only through the environment", () => {
    const entry = mcp.mcpServers.tessa;
    expect(entry.command).toBe("node");
    expect(entry.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/server/dist/server.cjs"]);
    expect(entry.env).toEqual({
      TESSA_URL: "${user_config.api_url}",
      TESSA_TOKEN: "${user_config.api_token}",
      TESSA_WATCH: "${user_config.watch_targets}",
      TESSA_CHANNEL: "${user_config.channel}",
    });
    expect(entry.timeout).toBe(1_800_000);
    expect(JSON.stringify(entry.args)).not.toContain("token");
  });

  it("lists the plugin in the repository marketplace", () => {
    const marketplace = readJson(join(pluginRoot, "..", ".claude-plugin", "marketplace.json"));
    expect(marketplace.name).toBe("tessa");
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: "tessa", source: "./plugin" })]);
  });
});

describe.each(SKILLS)("skill %s", (name) => {
  const folder = join(pluginRoot, "skills", name);
  const frontmatter = frontmatterOf(join(folder, "SKILL.md"));
  const readTools = new Set(TOOLS.filter((tool) => tool.access === "read").map((tool) => tool.name));

  it("has a reference file", () => {
    expect(statSync(join(folder, "reference.md")).size).toBeGreaterThan(500);
    expect(readdirSync(folder).sort()).toEqual(["SKILL.md", "reference.md"]);
  });

  it("has name, description and argument hint", () => {
    expect(frontmatter.name).toBe(name);
    expect(typeof frontmatter.description).toBe("string");
    expect(frontmatter.description.length).toBeLessThanOrEqual(1024);
    expect(typeof frontmatter["argument-hint"]).toBe("string");
  });

  it("pre-approves only read tools of the tessa server and read-only builtins", () => {
    const allowed = frontmatter["allowed-tools"] as string[];
    expect(Array.isArray(allowed)).toBe(true);
    for (const entry of allowed) {
      if (entry.startsWith(TOOL_PREFIX)) {
        expect(readTools.has(entry.slice(TOOL_PREFIX.length)), entry).toBe(true);
      } else {
        expect(ALLOWED_BUILTINS.some((pattern) => pattern.test(entry)), entry).toBe(true);
      }
    }
    expect(new Set(allowed).size).toBe(allowed.length);
  });

  it.each(["SKILL.md", "reference.md"])("%s only mentions tools that exist", (file) => {
    const body = readFileSync(join(folder, file), "utf8");
    const mentioned = [...body.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((match) => match[1] as string);
    const known = new Set(TOOLS.map((tool) => tool.name));
    const toolLike = mentioned.filter(
      (word) =>
        /^(get|list|set|start|wait|cancel|add|move|issue|validate|upload|put|update|plan_from|run_health|run_diff)_/.test(word) ||
        word === "whoami",
    );
    for (const word of toolLike.filter((entry) => !RESULT_FIELDS.has(entry))) {
      expect(known.has(word), word).toBe(true);
    }
  });

  it("states the rules", () => {
    const body = readFileSync(join(folder, "SKILL.md"), "utf8");
    expect(body).toMatch(/production/i);
    expect(body).toMatch(/never|do not|don't/i);
  });
});

describe("skill specifics", () => {
  it("fix needs an explanation, never resolves, refuses production and does not push", () => {
    const body = readFileSync(join(pluginRoot, "skills", "fix", "SKILL.md"), "utf8");
    expect(body).toMatch(/no explanation/);
    expect(body).toMatch(/Never claim a finding is resolved/);
    expect(body).toMatch(/never deploy to production/);
    expect(body).toMatch(/Do not push, merge, force/);
    expect(body).toContain("`scenario_ids`");
    expect(body).toContain("`verifying`");
    expect(body).toContain("fix/<first 8 characters of the finding id>");
  });

  it("fix pre-approves no write tool and no mutating git command", () => {
    const allowed = frontmatterOf(join(pluginRoot, "skills", "fix", "SKILL.md"))["allowed-tools"] as string[];
    for (const forbidden of ["start_run", "move_finding", "add_explanation", "upload_bundle"]) {
      expect(allowed.some((entry) => entry.endsWith(forbidden))).toBe(false);
    }
    expect(allowed.some((entry) => /git (branch|switch|checkout|commit|push|add)/.test(entry))).toBe(false);
  });

  it("discover asks for the source section and one confirmation before set_environment", () => {
    const body = readFileSync(join(pluginRoot, "skills", "discover", "SKILL.md"), "utf8");
    expect(body).toContain("source:");
    expect(body).toContain("commit:");
    expect(body).toContain("branch:");
    expect(body).toContain("dirty:");
    expect(body).toMatch(/ONE question/);
    expect(body).toContain("`set_environment`");
    expect(body).toMatch(/at most three passes/);
  });

  it("run asks before spending and refuses production", () => {
    const body = readFileSync(join(pluginRoot, "skills", "run", "SKILL.md"), "utf8");
    expect(body).toMatch(/confirm/);
    expect(body).toMatch(/Never start a run on a target with `tier` `production`/);
    expect(body).toMatch(/uncertain/);
  });

  const bodyOf = (name: string) => readFileSync(join(pluginRoot, "skills", name, "SKILL.md"), "utf8");
  const referenceOf = (name: string) => readFileSync(join(pluginRoot, "skills", name, "reference.md"), "utf8");

  it("no skill pre-approves a write tool or a mutating git command", () => {
    const writeTools = TOOLS.filter((tool) => tool.access === "write").map((tool) => tool.name);
    for (const name of SKILLS) {
      const allowed = frontmatterOf(join(pluginRoot, "skills", name, "SKILL.md"))["allowed-tools"] as string[];
      for (const tool of writeTools) {
        expect(allowed.includes(TOOL_PREFIX + tool), `${name} pre-approves ${tool}`).toBe(false);
      }
      expect(allowed.some((entry) => /git (switch|checkout|commit|push|add|reset|merge|rebase|stash)|git branch (-[a-zA-Z]|[a-z])/.test(entry)), name).toBe(false);
    }
  });

  it("propose keeps the previous keys, writes one file and never ticks without the user", () => {
    const body = bodyOf("propose");
    expect(body).toContain("`get_proposal`");
    expect(body).toContain("keys_only");
    expect(body).toMatch(/Keep the keys of the previous proposal/);
    expect(body).toMatch(/reuses its `key` exactly/);
    expect(body).toMatch(/Never tick, decline or reset an item unless the user told you/);
    expect(body).toMatch(/If the user names none, tick nothing/);
    expect(body).toContain("Write only `tessa/proposal.yaml`");
    expect(body).toContain('template: "propose"');
    expect(body).toContain("`put_proposal`");
    expect(body).toMatch(/at most three passes/);
    expect(body).toMatch(/Never write to a production target/);
    const order = ["`get_proposal`", "`issue_prompt`", "`put_proposal`", "`update_proposal_item`"].map((word) => body.indexOf(word, body.indexOf("## Steps")));
    expect(order.every((position) => position > 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(referenceOf("propose")).toMatch(/Keeping keys stable/);
    expect(referenceOf("propose")).toMatch(/Ticking is a team decision/);
  });

  it("author never writes to production, checks locally before it uploads and never approves", () => {
    const body = bodyOf("author");
    expect(body).toMatch(/Never write to a production target and never run anything against a production database/);
    expect(body).toMatch(/A scenario is never self-approved/);
    expect(body).toMatch(/read-only SELECT/);
    expect(body).toMatch(/Never put a password on a command line/);
    expect(body).toContain("proposal_item_ids");
    expect(body).toContain("cell_ids");
    expect(body).toContain("dry_run_run_id");
    const steps = body.slice(body.indexOf("## Steps"));
    const positions = [
      "`issue_prompt`",
      "Local checks, before the bundle goes anywhere",
      "Oracle SQL",
      "Seed script",
      "One flow",
      "Validate in a loop",
      "Upload. After confirmation",
      "Wait for the dry run",
    ].map((word) => steps.indexOf(word));
    expect(positions.every((position) => position >= 0), positions.join(",")).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(body).toMatch(/not run/);
    expect(body).toMatch(/ask before `upload_bundle`/);
  });

  it("mutants never merge, deploy or claim a result", () => {
    const body = bodyOf("mutants");
    expect(body).toMatch(/Never merge a mutant branch/);
    expect(body).toMatch(/Never deploy anything/);
    expect(body).toMatch(/One defect per branch/);
    expect(body).toMatch(/At most 3 bugs per invariant and 30 branches/);
    expect(body).toContain("tessa/mutants.yaml");
    expect(body).toContain("`upload_bundle`");
    expect(body).toContain('template: "mutants"');
  });

  it("hooks keep the switch off by default, never deploy and end with the health checks", () => {
    const body = bodyOf("hooks");
    expect(body).toMatch(/OFF by default/);
    expect(body).toMatch(/Do not push, merge, force or deploy/);
    expect(body).toContain('template: "hooks"');
    const steps = body.slice(body.indexOf("## Steps"));
    expect(steps.lastIndexOf("`run_health_checks`")).toBeGreaterThan(steps.lastIndexOf("`upload_bundle`"));
    expect(steps.indexOf("`run_health_checks`")).toBeGreaterThan(steps.indexOf("Deploy is the user's"));
  });

  it("fix moves the finding to verifying after the deploy and before the re-run, and moves nothing after it", () => {
    const body = bodyOf("fix");
    const steps = body.slice(body.indexOf("## Steps"), body.indexOf("## If the fix does not work"));
    const deploy = steps.indexOf("Deploy to the QA target");
    const verifying = steps.indexOf("`move_finding` with `status` `verifying`");
    const rerun = steps.indexOf("`start_run`", verifying);
    const outcome = steps.indexOf("`get_finding`", rerun);
    expect(deploy).toBeGreaterThan(0);
    expect(verifying).toBeGreaterThan(deploy);
    expect(rerun).toBeGreaterThan(verifying);
    expect(outcome).toBeGreaterThan(rerun);
    expect(steps.slice(rerun)).not.toMatch(/call `move_finding`|`move_finding` with/);
    expect(steps.slice(rerun)).toMatch(/leave it where the API put it/);
    expect(referenceOf("fix")).toMatch(/\| `in_fix` \| `verifying` \| the fix is live on QA and the user confirmed the re-run, just before `start_run` \|/);
  });

  it("run and fix reset the seed before a run unless the user says not to, and fall back only when nothing can be reset", () => {
    for (const name of ["run", "fix"]) {
      const body = bodyOf(name);
      const steps = body.slice(body.indexOf("## Steps")).split("\n");
      const callLines = steps.filter((line) => line.includes("`start_run` with") && line.includes("`reset_seed: true` unless the user said not to reset"));
      expect(callLines, name).toHaveLength(1);
      expect(body, name).toMatch(/seed mismatch/);
      expect(body, name).toContain("`seed_missing` or `hook_missing`");
      expect(body, name).toMatch(/once more with(out| the same request without) `reset_seed`/);
    }
    expect(referenceOf("run")).toMatch(/## Seed reset/);
    expect(referenceOf("fix")).toMatch(/`reset_seed: true`/);
  });

  it("explain and fix take commit as the commit that introduced the defect, never HEAD", () => {
    for (const name of ["explain", "fix"]) {
      expect(bodyOf(name) + referenceOf(name), name).toMatch(/commit that introduced the defect/);
      expect(bodyOf(name) + referenceOf(name), name).not.toMatch(/compare `git rev-parse HEAD` and the explanation's `commit`|the commit you read, from `git rev-parse HEAD`/);
    }
    expect(bodyOf("explain")).toMatch(/When you cannot identify it, leave `commit` out/);
    expect(bodyOf("explain")).toMatch(/Never fill it with `git rev-parse HEAD`/);
    expect(referenceOf("explain")).toMatch(/## Finding the commit that introduced the defect/);
  });

  it("explain never lets the model set resolved", () => {
    const body = readFileSync(join(pluginRoot, "skills", "explain", "SKILL.md"), "utf8");
    expect(body).toMatch(/`resolved` is never set by you/);
  });
});
