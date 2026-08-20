import { z } from "zod";

export const EMAIL_LIST_MAX_ITEMS = 20;
export const EMAIL_MAX_LENGTH = 254;

const SEPARATORS = /[\s,;]+/;
const addressSchema = z.email().max(EMAIL_MAX_LENGTH);

export interface ParsedEmailList {
  emails: string[];
  invalid: string[];
  tooMany: boolean;
}

export function parseEmailList(text: string): ParsedEmailList {
  const seen = new Set<string>();
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const candidate of text.split(SEPARATORS)) {
    if (candidate === "") {
      continue;
    }
    const key = candidate.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (addressSchema.safeParse(candidate).success) {
      emails.push(candidate);
    } else {
      invalid.push(candidate);
    }
  }
  return { emails, invalid, tooMany: emails.length > EMAIL_LIST_MAX_ITEMS };
}

export function describeEmailListProblem(parsed: ParsedEmailList): string | null {
  if (parsed.invalid.length > 0) {
    const noun = parsed.invalid.length === 1 ? "address" : "addresses";
    return `Not a valid email ${noun}: ${parsed.invalid.join(", ")}`;
  }
  if (parsed.tooMany) {
    return `Use at most ${EMAIL_LIST_MAX_ITEMS} addresses`;
  }
  return null;
}

export function formatEmailList(emails: readonly string[]): string {
  return emails.join("\n");
}
