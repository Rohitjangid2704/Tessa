import { writeFileSync } from "node:fs";

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}

const capturePath = process.env.FAKE_CLAUDE_CAPTURE;
if (capturePath) {
  writeFileSync(
    capturePath,
    JSON.stringify({
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      stdin: Buffer.concat(chunks).toString("utf8"),
      hasToken: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN),
    }),
  );
}

const mode = process.env.FAKE_CLAUDE_MODE ?? "done";
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
const base = { type: "result", session_id: "11111111-2222-3333-4444-555555555555", total_cost_usd: 0.42, num_turns: 5 };

const emit = (value) => {
  process.stdout.write(JSON.stringify({ ...base, ...value }));
};

if (mode === "done") {
  emit({
    subtype: "success",
    is_error: false,
    result: "ok",
    structured_output: { outcome: "done", proposal_id: "prop-1", summary: "Stored 12 items." },
  });
} else if (mode === "blocked") {
  emit({
    subtype: "success",
    is_error: false,
    result: "blocked",
    structured_output: { outcome: "blocked", summary: "Needs a person to confirm the environment values." },
  });
} else if (mode === "leak") {
  emit({
    subtype: "success",
    is_error: false,
    structured_output: { outcome: "done", summary: `token ${token} and ipt_abcdef0123456789 leaked` },
  });
} else if (mode === "auth-error") {
  emit({ subtype: "success", is_error: true, api_error_status: 401, result: `Failed to authenticate with ${token}` });
  process.exitCode = 1;
} else if (mode === "max-turns") {
  emit({ subtype: "error_max_turns", is_error: true, result: "" });
  process.exitCode = 1;
} else if (mode === "no-structured") {
  emit({ subtype: "success", is_error: false, result: "I looked around but gave no structured answer." });
} else if (mode === "bad-structured") {
  emit({ subtype: "success", is_error: false, structured_output: { outcome: "maybe", summary: "x" } });
} else if (mode === "garbage") {
  process.stdout.write("not json at all");
} else if (mode === "crash") {
  process.stderr.write(`fatal: something broke near ${token}`);
  process.exitCode = 3;
} else if (mode === "slow") {
  await new Promise((resolve) => setTimeout(resolve, 60000));
}
