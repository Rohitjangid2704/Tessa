export const REDACTED = "[redacted]";

const PERSONAL_TOKEN_PATTERN = /ipt_[A-Za-z0-9_-]{5,}/g;
const BEARER_PATTERN = /(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const SECRET_KEY_WORDS = new Set([
  "password",
  "passwd",
  "secret",
  "secrets",
  "token",
  "dsn",
  "key",
  "apikey",
  "authorization",
  "cookie",
]);
const PLAIN_KEYS = new Set(["target_token", "token_prefix"]);
const MINIMUM_LITERAL_LENGTH = 6;

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

export function isSecretKey(key: string): boolean {
  if (PLAIN_KEYS.has(key)) {
    return false;
  }
  return keyWords(key).some((word) => SECRET_KEY_WORDS.has(word));
}

class PlainText {
  constructor(readonly value: string) {}

  toJSON(): string {
    return this.value;
  }
}

export function plain(value: string): string {
  return new PlainText(value) as unknown as string;
}

export class Redactor {
  private readonly literals = new Set<string>();

  addLiteral(value: string | undefined | null): void {
    if (value && value.length >= MINIMUM_LITERAL_LENGTH) {
      this.literals.add(value);
    }
  }

  clearLiterals(): void {
    this.literals.clear();
  }

  text(input: string): string {
    let output = input;
    for (const literal of this.literals) {
      output = output.split(literal).join(REDACTED);
    }
    return output.replace(PERSONAL_TOKEN_PATTERN, REDACTED).replace(BEARER_PATTERN, `$1${REDACTED}`);
  }

  value<T>(input: T): T {
    return this.walk(input, false) as T;
  }

  private walk(input: unknown, forced: boolean): unknown {
    if (input instanceof PlainText) {
      return this.text(input.value);
    }
    if (typeof input === "string") {
      return forced ? REDACTED : this.text(input);
    }
    if (Array.isArray(input)) {
      return input.map((entry) => this.walk(entry, forced));
    }
    if (typeof input === "object" && input !== null) {
      const output: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(input)) {
        output[key] = this.walk(entry, forced || isSecretKey(key));
      }
      return output;
    }
    return input;
  }
}
