export const HOOK_DEADLINE_MILLISECONDS = 4500;
export const STDIN_WAIT_MILLISECONDS = 1500;
export const MAX_INBOX_LINES = 10;
export const MAX_LINE_CHARACTERS = 300;
export const SUMMARY_CHARACTERS = 500;

const CONTROL_CHARACTERS = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff\\ufff9-\\ufffb]",
  "g",
);

const AFFECTED_NODE_MAJORS = new Set([23, 25]);
const FIXED_IN_NODE_24 = 20;

export function runtimeAdvisory(nodeVersion, platform) {
  if (platform !== "win32") {
    return null;
  }
  const [major = 0, minor = 0] = String(nodeVersion).replace(/^v/, "").split(".").map(Number);
  if (!AFFECTED_NODE_MAJORS.has(major) && !(major === 24 && minor < FIXED_IN_NODE_24)) {
    return null;
  }
  return `Node ${nodeVersion} on Windows can abort the tessa MCP server with exit code 3221226505 (a libuv assertion fixed in Node 24.20.0, nodejs/node#61999); its tools then fail with "Connection closed". Upgrade Node to 24.20.0 or later.`;
}

export function safeFileName(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
}

export function redactSecrets(text, env) {
  let output = String(text);
  const token = (env.CLAUDE_PLUGIN_OPTION_API_TOKEN ?? "").trim();
  if (token.length >= 6) {
    output = output.split(token).join("[redacted]");
  }
  return output
    .replace(/ipt_[A-Za-z0-9_-]{5,}/g, "[redacted]")
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]");
}

export function cleanLine(text, maxCharacters = MAX_LINE_CHARACTERS) {
  const flat = String(text)
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(flat);
  return characters.length <= maxCharacters ? flat : `${characters.slice(0, maxCharacters - 1).join("")}…`;
}

export function firstCharacters(text, count) {
  return Array.from(String(text)).slice(0, count).join("");
}

export function pluginDataDirectory(env) {
  const directory = (env.CLAUDE_PLUGIN_DATA ?? "").trim();
  return directory.length > 0 ? directory : null;
}

function readStdin(waitMilliseconds) {
  return new Promise((resolve) => {
    const chunks = [];
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, waitMilliseconds);
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("end", finish);
    process.stdin.on("close", finish);
    process.stdin.on("error", finish);
    process.stdin.resume();
  });
}

function parseInput(text) {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function hookOutput(eventName, additionalContext) {
  return { hookSpecificOutput: { hookEventName: eventName, additionalContext } };
}

export async function runHook(handler) {
  const deadline = setTimeout(() => process.exit(0), HOOK_DEADLINE_MILLISECONDS);
  let output;
  try {
    const input = parseInput(await readStdin(STDIN_WAIT_MILLISECONDS));
    output = await handler(input, process.env);
  } catch {
    output = undefined;
  }
  clearTimeout(deadline);
  if (output === undefined || output === null) {
    process.exit(0);
  }
  let text;
  try {
    text = JSON.stringify(output);
  } catch {
    process.exit(0);
  }
  process.stdout.write(`${text}\n`, () => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
