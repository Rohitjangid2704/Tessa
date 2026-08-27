import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SUMMARY_CHARACTERS, firstCharacters, pluginDataDirectory, redactSecrets, runHook, safeFileName } from "./hook-common.mjs";

const REQUEST_TIMEOUT_MILLISECONDS = 3500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function baseUrlOf(raw) {
  const trimmed = String(raw ?? "").trim().replace(/\/api\/v1\/?$/, "").replace(/\/+$/, "");
  try {
    const parsed = new URL(trimmed);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}

await runHook(async (input, env) => {
  const message = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
  const claudeSessionId = typeof input.session_id === "string" ? safeFileName(input.session_id) : "";
  const dataDirectory = pluginDataDirectory(env);
  const token = (env.CLAUDE_PLUGIN_OPTION_API_TOKEN ?? "").trim();
  const baseUrl = baseUrlOf(env.CLAUDE_PLUGIN_OPTION_API_URL);
  if (message.trim().length === 0 || claudeSessionId.length === 0 || dataDirectory === null || token.length === 0 || baseUrl === null) {
    return undefined;
  }
  const record = JSON.parse(await readFile(join(dataDirectory, "sessions", `${claudeSessionId}.json`), "utf8"));
  const agentSessionId = typeof record.agent_session_id === "string" ? record.agent_session_id : "";
  if (!UUID.test(agentSessionId)) {
    return undefined;
  }
  const summary = redactSecrets(firstCharacters(redactSecrets(message, env), SUMMARY_CHARACTERS), env);
  const response = await fetch(`${baseUrl}/api/v1/agent-sessions/${agentSessionId}`, {
    method: "PATCH",
    redirect: "manual",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ summary }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
  });
  await response.body?.cancel().catch(() => undefined);
  return undefined;
});
