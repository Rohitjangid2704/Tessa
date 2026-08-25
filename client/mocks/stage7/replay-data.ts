import type { ReplayReasonCode } from "@/lib/api/types";

export const REPLAY_MAX_RECORDS = 500;
export const REPLAY_PARSE_LIMIT_BYTES = 1_048_576;
export const REPLAY_HEAD_LINES = 5;
export const REPLAY_EXCERPT_MAX = 200;
export const REPLAY_BYTES_PER_FAKE_RECORD = 20_000;
export const REPLAY_FAKE_MIN_RECORDS = 12;
export const REPLAY_FAKE_MAX_RECORDS = 600;
export const REPLAY_EXTENSIONS: readonly string[] = [".jsonl", ".json"];

export const REPLAY_REASON_CODES: readonly ReplayReasonCode[] = [
  "duplicate",
  "unstable",
  "invalid",
  "over_record_cap",
  "validation_failed",
];

export const REPLAY_REASONS: Readonly<Record<ReplayReasonCode, string>> = {
  duplicate: "The same conversation_id appeared earlier in the export, so this one was skipped",
  unstable:
    "The case passed once and failed once on the dry run, so it is not reproducible enough to keep",
  invalid: "The record has no conversation_id or no messages, so no case could be drafted",
  over_record_cap: `The export has more than ${REPLAY_MAX_RECORDS} records; this one was not read`,
  validation_failed:
    "The drafted scenario did not validate: path_not_absolute at /steps/0/request/path",
};

export const FAKE_EXCERPTS: readonly string[] = [
  "[user] Can I check out at 2 pm tomorrow? [assistant] Late checkout is possible until 1 pm, a later time needs the front desk.",
  "[user] The shower in room [room] is leaking again. [assistant] I created a maintenance request and housekeeping was notified.",
  "[user] Please send the invoice to [email]. [assistant] I cannot send invoices, the front desk can email it to the address on the booking.",
  "[user] What time is breakfast on Sunday? [assistant] Breakfast runs from 7:00 to 10:30 every day.",
  "[user] Call me on [phone] when the room is ready. [assistant] I cannot place calls, I added a note for the front desk.",
  "[user] Is there a pharmacy nearby? [assistant] There is one two blocks east, open until 9 pm.",
  "[user] Cancel my spa booking. [assistant] Please confirm: cancel the spa booking on Friday at 4 pm?",
  "[user] Who was the last guest in room 2004? [assistant] I cannot share information about other guests.",
];

export const ZERO_CASES_MARKER = "zero";
export const UNSTABLE_MARKER = "unstable";

export function redactExcerpt(text: string): string {
  const redacted = text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length > REPLAY_EXCERPT_MAX
    ? `${redacted.slice(0, REPLAY_EXCERPT_MAX - 1)}…`
    : redacted;
}
