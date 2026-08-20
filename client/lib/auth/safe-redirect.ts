const PARSE_BASE = "http://safe-redirect.invalid";
const MAX_CALLBACK_LENGTH = 2048;
const LOGIN_PATH_PREFIX = /^\/login(?:[/?#]|$)/;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function safeCallbackPath(value: string | null | undefined, fallback = "/"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CALLBACK_LENGTH) {
    return fallback;
  }
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return fallback;
  }
  if (hasControlCharacter(value) || LOGIN_PATH_PREFIX.test(value)) {
    return fallback;
  }
  let parsed: URL;
  try {
    parsed = new URL(value, PARSE_BASE);
  } catch {
    return fallback;
  }
  if (parsed.origin !== PARSE_BASE) {
    return fallback;
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
