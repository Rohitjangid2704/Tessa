export type ServerConfig = {
  baseUrl: string;
  token: string;
  problem: string | null;
  cwd: string;
  claudeSessionId: string;
};

const API_SUFFIX = /\/api\/v1\/?$/;

type BaseUrlResult = { url: string; problem: null } | { url: ""; problem: string };

export function normaliseBaseUrl(raw: string): BaseUrlResult {
  const trimmed = raw.trim().replace(API_SUFFIX, "").replace(/\/+$/, "");
  if (trimmed.length === 0) {
    return { url: "", problem: "TESSA_URL is not set" };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { url: "", problem: "TESSA_URL is not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { url: "", problem: "TESSA_URL must start with http:// or https://" };
  }
  if (parsed.username || parsed.password) {
    return { url: "", problem: "TESSA_URL must not carry credentials" };
  }
  return { url: trimmed, problem: null };
}

export function readConfig(
  env: NodeJS.ProcessEnv,
  cwd: string,
  generateId: () => string,
): ServerConfig {
  const base = normaliseBaseUrl(env.TESSA_URL ?? "");
  const token = (env.TESSA_TOKEN ?? "").trim();
  const problem = base.problem ?? (token.length === 0 ? "TESSA_TOKEN is not set" : null);
  return {
    baseUrl: base.url,
    token,
    problem,
    cwd,
    claudeSessionId:
      (env.CLAUDE_SESSION_ID ?? "").trim() || (env.CLAUDE_CODE_SESSION_ID ?? "").trim() || generateId(),
  };
}

export type InboxSettings = {
  dataDir: string | null;
  watch: string[];
  channel: boolean;
  feeds: boolean;
  random?: () => number;
  idleTimeoutMilliseconds?: number;
  fetchImpl?: typeof fetch;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseWatchList(raw: string | undefined): string[] {
  const text = (raw ?? "").trim();
  if (text.length === 0) {
    return [];
  }
  let candidates: string[];
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      candidates = Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
      candidates = text.split(/[\s,;[\]"']+/);
    }
  } else {
    candidates = text.split(/[\s,;]+/);
  }
  const unique = new Set<string>();
  for (const candidate of candidates) {
    const id = candidate.trim().toLowerCase();
    if (UUID_PATTERN.test(id)) {
      unique.add(id);
    }
  }
  return [...unique];
}

export function readInboxSettings(env: NodeJS.ProcessEnv): InboxSettings {
  const dataDir = (env.CLAUDE_PLUGIN_DATA ?? "").trim();
  return {
    dataDir: dataDir.length > 0 ? dataDir : null,
    watch: parseWatchList(env.TESSA_WATCH),
    channel: (env.TESSA_CHANNEL ?? "").trim().toLowerCase() === "true",
    feeds: true,
  };
}
