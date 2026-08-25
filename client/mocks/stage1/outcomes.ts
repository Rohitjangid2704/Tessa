import type { ContentKind } from "./bundle-content";

export type UploadOutcome =
  | { type: "ingest"; kind: ContentKind }
  | { type: "duplicate" }
  | { type: "too_large" }
  | { type: "secret" }
  | { type: "token_unknown" }
  | { type: "token_mismatch" };

export const UPLOAD_FILE_NAMES = {
  valid: "valid.zip",
  belowBar: "below-bar.zip",
  invalid: "invalid.zip",
  secret: "secret.zip",
  duplicate: "duplicate.zip",
  tooLarge: "too-large.zip",
  mismatch: "mismatch.zip",
  unknownToken: "unknown-token.zip",
  notAZip: "not-a-zip.txt",
} as const;

export const PASTE_MARKER_PATTERN =
  /^#\s*mock:\s*(valid|below-bar|invalid|secret|duplicate|unknown-token|mismatch)\s*$/m;

const TOKEN_PATTERN = /tgt_[a-z2-7]{22}/;

const RULES: ReadonlyArray<[string, UploadOutcome]> = [
  ["too-large", { type: "too_large" }],
  ["unknown-token", { type: "token_unknown" }],
  ["mismatch", { type: "token_mismatch" }],
  ["secret", { type: "secret" }],
  ["duplicate", { type: "duplicate" }],
  ["below-bar", { type: "ingest", kind: "below_bar" }],
  ["invalid", { type: "ingest", kind: "invalid" }],
];

export function outcomeForName(rawName: string): UploadOutcome {
  const name = rawName.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  for (const [marker, outcome] of RULES) {
    if (name.includes(marker)) {
      return outcome;
    }
  }
  return { type: "ingest", kind: "valid" };
}

export function outcomeForPaste(manifestYaml: string): UploadOutcome {
  const marker = PASTE_MARKER_PATTERN.exec(manifestYaml)?.[1];
  if (marker === undefined) {
    return { type: "ingest", kind: "paste" };
  }
  const found = RULES.find(([name]) => name === marker);
  if (found !== undefined) {
    return found[1];
  }
  return { type: "ingest", kind: "valid" };
}

export function extractToken(text: string): string | null {
  return TOKEN_PATTERN.exec(text)?.[0] ?? null;
}

export const SECRET_DETAILS: Array<{ loc: Array<string | number>; code: string; message: string }> =
  [
    {
      loc: ["file", "env.template", 7],
      code: "aws_access_key",
      message: "AWS_ACCESS_KEY_ID=[REDACTED]",
    },
    {
      loc: ["file", "seeds/reset.sql", 12],
      code: "dsn_password",
      message: "-- psql postgresql://qa_user:[REDACTED]@db.internal:5432/gracie",
    },
  ];
