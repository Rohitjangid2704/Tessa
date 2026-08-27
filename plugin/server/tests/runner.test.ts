import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(here, "..", "..");
const RUNNER = join(PLUGIN_ROOT, "bin", "tessa-loop");
const FAKE_CLAUDE = join(here, "fake-claude.mjs");
const OAUTH_TOKEN = "sk-ant-oat01-TESTONLYSECRETVALUE0123456789";
const EXPECTED_TOOLS =
  "mcp__plugin_tessa_tessa__*,Read,Grep,Glob,Edit,Write,Bash(git *),Bash(npm test*),Bash(uv run*)";

const loaded = createRequire(import.meta.url)(RUNNER) as {
  resolveClaude: (environment: Record<string, string | undefined>, platform: string) => { file: string; prefix: string[] };
  parseArguments: (argv: string[]) => { command: string | null; options: Record<string, string> };
  stripFrontmatter: (text: string) => string;
  UsageError: new (message: string) => Error;
};

type Capture = {
  argv: string[];
  cwd: string;
  stdin: string;
  hasToken: boolean;
};

let scratch = "";
let repo = "";
let counter = 0;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "tessa loop "));
  repo = join(scratch, "my repo & 100% ^app");
  mkdirSync(repo, { recursive: true });
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

type RunOptions = {
  mode?: string;
  env?: Record<string, string | undefined>;
  repoPath?: string;
};

function run(args: string[], options: RunOptions = {}) {
  counter += 1;
  const capture = join(scratch, `capture-${counter}.json`);
  const env: Record<string, string | undefined> = {
    ...process.env,
    TESSA_LOOP_CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_CAPTURE: capture,
    FAKE_CLAUDE_MODE: options.mode ?? "done",
    CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN,
    ANTHROPIC_API_KEY: undefined,
    ...options.env,
  };
  const result = spawnSync(process.execPath, [RUNNER, ...args], {
    env: env as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 60000,
  });
  const captured: Capture | null = existsSync(capture)
    ? (JSON.parse(readFileSync(capture, "utf8")) as Capture)
    : null;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, captured };
}

function baseArgs(command = "propose", extra: string[] = []) {
  return [command, "--target", "tgt-1", "--repo", repo, ...extra];
}

function argAfter(argv: string[], flag: string) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function skillBody(command: string, argumentsText: string) {
  const text = readFileSync(join(PLUGIN_ROOT, "skills", command, "SKILL.md"), "utf8");
  return loaded.stripFrontmatter(text).split("$ARGUMENTS").join(argumentsText);
}

describe("outcomes and exit codes", () => {
  it("exits 0 on done and prints one JSON object with the result and the cost", () => {
    const result = run(baseArgs());
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      outcome: "done",
      proposal_id: "prop-1",
      summary: "Stored 12 items.",
      total_cost_usd: 0.42,
      session_id: "11111111-2222-3333-4444-555555555555",
    });
  });

  it("exits 1 on blocked", () => {
    const result = run(baseArgs(), { mode: "blocked" });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "blocked", total_cost_usd: 0.42 });
  });

  it("exits 1 as blocked when claude stops at the turn limit", () => {
    const result = run(baseArgs(), { mode: "max-turns" });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "blocked", summary: expect.stringContaining("max_turns") });
  });

  it("exits 1 as blocked when there is no valid structured result", () => {
    for (const mode of ["no-structured", "bad-structured"]) {
      const result = run(baseArgs(), { mode });
      expect(result.status, mode).toBe(1);
      expect(JSON.parse(result.stdout).outcome, mode).toBe("blocked");
    }
  });

  it("exits 2 when claude reports an error, prints nothing on stdout and hides the token", () => {
    const result = run(baseArgs(), { mode: "auth-error" });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("claude failed");
    expect(result.stderr).not.toContain(OAUTH_TOKEN);
  });

  it("exits 2 when claude prints no JSON, and hides the token in the stderr tail", () => {
    for (const mode of ["garbage", "crash"]) {
      const result = run(baseArgs(), { mode });
      expect(result.status, mode).toBe(2);
      expect(result.stdout, mode).toBe("");
      expect(result.stderr, mode).not.toContain(OAUTH_TOKEN);
    }
  });

  it("exits 2 after the hard timeout and ends the claude process", () => {
    const started = Date.now();
    const result = run(baseArgs("propose", ["--timeout-minutes", "0.03"]), { mode: "slow" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(30000);
  });
});

describe("usage errors", () => {
  const cases: [string, string[]][] = [
    ["no arguments", []],
    ["unknown command", ["deploy", "--target", "t", "--repo", "."]],
    ["missing target", ["propose", "--repo", "."]],
    ["missing repo", ["propose", "--target", "t"]],
    ["explain without a finding", ["explain", "--target", "t", "--repo", "."]],
    ["finding on propose", ["propose", "--target", "t", "--repo", ".", "--finding", "f1"]],
    ["items on explain", ["explain", "--target", "t", "--repo", ".", "--finding", "f1", "--items", "a"]],
    ["unknown flag", ["propose", "--target", "t", "--repo", ".", "--dangerously", "x"]],
    ["flag without value", ["propose", "--target", "t", "--repo"]],
    ["target with a space", ["propose", "--target", "a b", "--repo", "."]],
    ["target with shell characters", ["propose", "--target", "a;rm", "--repo", "."]],
    ["max turns zero", ["propose", "--target", "t", "--repo", ".", "--max-turns", "0"]],
    ["max turns text", ["propose", "--target", "t", "--repo", ".", "--max-turns", "many"]],
    ["max turns above the ceiling", ["propose", "--target", "t", "--repo", ".", "--max-turns", "501"]],
    ["repo that does not exist", ["propose", "--target", "t", "--repo", "this-folder-does-not-exist"]],
    ["second positional", ["propose", "run", "--target", "t", "--repo", "."]],
  ];

  for (const [name, args] of cases) {
    it(`exits 2 for ${name} and never starts claude`, () => {
      const result = run(args);
      expect(result.status).toBe(2);
      expect(result.captured).toBeNull();
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("usage:");
    });
  }

  it("refuses a repo that is a file", () => {
    const file = join(scratch, "a-file.txt");
    writeFileSync(file, "x");
    const result = run(["propose", "--target", "t", "--repo", file]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not a directory");
  });

  it("prints the usage and exits 0 for --help", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("usage: tessa-loop");
  });
});

describe("missing claude", () => {
  it("exits 2 when the override does not exist", () => {
    const result = run(baseArgs(), { env: { TESSA_LOOP_CLAUDE_BIN: join(scratch, "no-such-claude") } });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("TESSA_LOOP_CLAUDE_BIN");
  });

  it("exits 2 when claude is not on PATH", () => {
    const empty = join(scratch, "empty-path");
    mkdirSync(empty, { recursive: true });
    const result = run(baseArgs(), {
      env: { TESSA_LOOP_CLAUDE_BIN: undefined, PATH: empty, Path: undefined },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("claude was not found");
  });
});

describe("the claude invocation", () => {
  it("runs in the repo, even when the path has spaces, ampersands, percents and carets", () => {
    const result = run(baseArgs());
    expect(result.captured).not.toBeNull();
    expect(realpathSync.native(result.captured?.cwd as string).toLowerCase()).toBe(realpathSync.native(repo).toLowerCase());
  });

  it("passes the exact flags", () => {
    const argv = run(baseArgs()).captured?.argv as string[];
    expect(argv[0]).toBe("-p");
    expect(argAfter(argv, "--allowedTools")).toBe(EXPECTED_TOOLS);
    expect(argAfter(argv, "--permission-mode")).toBe("acceptEdits");
    expect(argAfter(argv, "--output-format")).toBe("json");
    expect(argAfter(argv, "--max-turns")).toBe("60");
    expect(argv).not.toContain("--max-budget-usd");
    expect(argv.filter((entry) => entry === "--allowedTools")).toHaveLength(1);
  });

  it("uses --max-turns 60 by default and honours an override", () => {
    expect(argAfter(run(baseArgs()).captured?.argv as string[], "--max-turns")).toBe("60");
    expect(argAfter(run(baseArgs("propose", ["--max-turns", "7"])).captured?.argv as string[], "--max-turns")).toBe("7");
    expect(argAfter(run(baseArgs("propose", ["--max-turns=9"])).captured?.argv as string[], "--max-turns")).toBe("9");
  });

  it("passes a budget cap only when asked", () => {
    const argv = run(baseArgs("propose", ["--max-budget-usd", "5"])).captured?.argv as string[];
    expect(argAfter(argv, "--max-budget-usd")).toBe("5");
  });

  it("asks for the structured result with a closed schema", () => {
    const argv = run(baseArgs()).captured?.argv as string[];
    const schema = JSON.parse(argAfter(argv, "--json-schema") as string);
    expect(schema.properties.outcome.enum).toEqual(["done", "blocked"]);
    expect(schema.required).toEqual(["outcome", "summary"]);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(
      ["bundle_id", "finding_id", "outcome", "proposal_id", "run_id", "summary"].sort(),
    );
  });

  it("appends the skill text without frontmatter, with the arguments filled in and the non-interactive rules", () => {
    const prompt = argAfter(run(baseArgs()).captured?.argv as string[], "--append-system-prompt") as string;
    expect(prompt).toContain(skillBody("propose", "tgt-1"));
    expect(prompt).not.toContain("allowed-tools:");
    expect(prompt).not.toContain("argument-hint:");
    expect(prompt).not.toContain("$ARGUMENTS");
    expect(prompt).toContain("Non-interactive run");
    expect(prompt).toContain("Never ask a question");
    expect(prompt).toContain("outcome blocked");
    expect(prompt.indexOf("Non-interactive run")).toBeGreaterThan(prompt.indexOf(skillBody("propose", "tgt-1")));
  });

  it("carries the skill text through argv byte for byte for every command", () => {
    const cases: [string, string[], string][] = [
      ["propose", [], "tgt-1"],
      ["discover", [], "tgt-1"],
      ["author", ["--items", "a1,b2"], "tgt-1 a1,b2"],
      ["explain", ["--finding", "fnd-9"], "fnd-9"],
      ["run", ["--items", "s1"], "tgt-1 s1"],
    ];
    for (const [command, extra, argumentsText] of cases) {
      const result = run(baseArgs(command, extra));
      expect(result.status, command).toBe(0);
      const prompt = argAfter(result.captured?.argv as string[], "--append-system-prompt") as string;
      expect(prompt, command).toContain(skillBody(command, argumentsText));
    }
  });

  it("sends the task on stdin, not on argv", () => {
    const result = run(baseArgs("explain", ["--finding", "fnd-9"]));
    expect(result.captured?.stdin).toContain("explain procedure");
    expect(result.captured?.stdin).toContain("Target: tgt-1");
    expect(result.captured?.stdin).toContain("Finding: fnd-9");
    expect(result.captured?.argv.join("\n")).not.toContain("Finding: fnd-9");
  });
});

describe("secrets", () => {
  it("never puts the Claude token on argv or stdout, and still passes it to claude through the environment", () => {
    const result = run(baseArgs());
    expect(result.captured?.hasToken).toBe(true);
    expect(JSON.stringify(result.captured?.argv)).not.toContain(OAUTH_TOKEN);
    expect(result.captured?.stdin).not.toContain(OAUTH_TOKEN);
    expect(result.stdout).not.toContain(OAUTH_TOKEN);
    expect(result.stderr).not.toContain(OAUTH_TOKEN);
  });

  it("redacts tokens that the model writes into the summary", () => {
    const result = run(baseArgs(), { mode: "leak" });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(OAUTH_TOKEN);
    expect(result.stdout).not.toContain("ipt_abcdef0123456789");
    expect(JSON.parse(result.stdout).summary).toContain("[redacted]");
  });

  it("warns on stderr when an API key would override the subscription", () => {
    const result = run(baseArgs(), { env: { ANTHROPIC_API_KEY: "sk-ant-api03-ANOTHERSECRETVALUE" } });
    expect(result.stderr).toContain("ANTHROPIC_API_KEY");
    expect(result.stderr).not.toContain("ANOTHERSECRETVALUE");
  });
});

describe("claude lookup", () => {
  it("finds claude.exe, or the exe behind an npm claude.cmd shim, on a Windows PATH", () => {
    const directory = join(scratch, "npm-bin");
    const exeDirectory = join(directory, "node_modules", "@anthropic-ai", "claude-code", "bin");
    mkdirSync(exeDirectory, { recursive: true });
    writeFileSync(join(exeDirectory, "claude.exe"), "");
    writeFileSync(
      join(directory, "claude.cmd"),
      '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n',
    );
    const viaShim = loaded.resolveClaude({ PATH: directory }, "win32");
    expect(viaShim.file).toBe(join(exeDirectory, "claude.exe"));
    expect(viaShim.prefix).toEqual([]);

    const direct = join(scratch, "direct-bin");
    mkdirSync(direct, { recursive: true });
    writeFileSync(join(direct, "claude.exe"), "");
    expect(loaded.resolveClaude({ PATH: `${join(scratch, "nothing")};${direct}` }, "win32").file).toBe(join(direct, "claude.exe"));
  });

  it("refuses a claude.cmd that does not point at an exe", () => {
    const directory = join(scratch, "odd-bin");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "claude.cmd"), "@echo off\r\nnode something.js %*\r\n");
    expect(() => loaded.resolveClaude({ PATH: directory }, "win32")).toThrow(/TESSA_LOOP_CLAUDE_BIN/);
  });

  it("finds claude on a POSIX PATH", () => {
    const directory = join(scratch, "posix-bin");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "claude"), "#!/bin/sh\n");
    const withoutDrive = (folder: string) => folder.replace(/^[A-Za-z]:/, "");
    const searched = `${withoutDrive(join(scratch, "nothing"))}:${withoutDrive(directory)}`;
    expect(loaded.resolveClaude({ PATH: searched }, "linux").file).toBe(join(withoutDrive(directory), "claude"));
  });

  it("runs a JavaScript override through node", () => {
    const launch = loaded.resolveClaude({ TESSA_LOOP_CLAUDE_BIN: FAKE_CLAUDE }, process.platform);
    expect(launch.file).toBe(process.execPath);
    expect(launch.prefix).toEqual([FAKE_CLAUDE]);
  });
});

describe("the runner file", () => {
  it("is executable in git so a Linux or macOS checkout can run it", () => {
    const listed = spawnSync("git", ["ls-files", "-s", "--", "bin/tessa-loop"], { cwd: PLUGIN_ROOT, encoding: "utf8" });
    expect(listed.status).toBe(0);
    expect(listed.stdout.slice(0, 6)).toBe("100755");
  });

  it("starts with a node shebang and has LF line endings", () => {
    const text = readFileSync(RUNNER, "utf8");
    expect(text.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(text).not.toContain("\r");
  });
});

describe("argument parsing", () => {
  it("accepts --flag=value and rejects a repeated flag", () => {
    const parsed = loaded.parseArguments(["run", "--target=t1", "--repo", "x"]);
    expect(parsed.command).toBe("run");
    expect(parsed.options["--target"]).toBe("t1");
    expect(() => loaded.parseArguments(["run", "--target", "a", "--target", "b"])).toThrow(/twice/);
  });

  it("strips CRLF frontmatter", () => {
    expect(loaded.stripFrontmatter("---\r\nname: x\r\n---\r\nBody\r\n")).toBe("Body");
  });
});
