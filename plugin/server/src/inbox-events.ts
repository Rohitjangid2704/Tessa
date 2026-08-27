export const INBOX_KINDS = [
  "finding.created",
  "run.finished",
  "generation.progress",
  "proposal.updated",
  "coverage.updated",
] as const;

export type InboxKind = (typeof INBOX_KINDS)[number];

export type InboxLine = {
  kind: InboxKind;
  targetId: string;
  id: string;
  text: string;
  dedupeKey: string;
};

export type CoverageSignal = {
  targetId: string;
  planId: string | null;
  reason: string;
  dedupeKey: string;
};

export type Interpretation =
  | { type: "line"; line: InboxLine }
  | { type: "coverage"; signal: CoverageSignal }
  | { type: "ignored" };

export const MAX_TEXT_CHARACTERS = 160;
export const MAX_LINE_CHARACTERS = 300;

const CONTROL_CHARACTERS = new RegExp(
  "[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]",
  "g",
);
const SAFE_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export function escapeText(value: unknown, maxCharacters: number = MAX_TEXT_CHARACTERS): string {
  const text = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  const flat = text
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(flat);
  if (characters.length <= maxCharacters) {
    return flat;
  }
  return `${characters.slice(0, maxCharacters - 1).join("")}…`;
}

export function safeId(value: unknown): string {
  return typeof value === "string" && SAFE_ID.test(value) ? value : "unknown";
}

export function formatLine(line: InboxLine): string {
  const full = `kind=${line.kind} target=${line.targetId} id=${line.id} ${line.text}`;
  const characters = Array.from(full);
  if (characters.length <= MAX_LINE_CHARACTERS) {
    return full;
  }
  return `${characters.slice(0, MAX_LINE_CHARACTERS - 1).join("")}…`;
}

type Envelope = {
  type: string;
  run_id: unknown;
  seq: unknown;
  ts: unknown;
  payload: Record<string, unknown>;
};

export function parseEnvelope(data: string): Envelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.type !== "string") {
    return null;
  }
  const payload =
    typeof record.payload === "object" && record.payload !== null && !Array.isArray(record.payload)
      ? (record.payload as Record<string, unknown>)
      : {};
  return { type: record.type, run_id: record.run_id, seq: record.seq, ts: record.ts, payload };
}

function counterOf(counters: unknown, key: string): number {
  if (typeof counters !== "object" || counters === null) {
    return 0;
  }
  const value = (counters as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function tail(...parts: unknown[]): string {
  return parts.map((part) => (typeof part === "string" || typeof part === "number" ? String(part) : "")).join(":");
}

export function interpretEvent(envelope: Envelope, watchedTargetId: string): Interpretation {
  const payload = envelope.payload;
  switch (envelope.type) {
    case "finding.created": {
      const id = safeId(payload.finding_id);
      const known = payload.is_new === false ? " (already known)" : "";
      const text = `${escapeText(payload.severity, 20)} ${escapeText(payload.class, 40)} '${escapeText(payload.title)}'${known}`;
      return {
        type: "line",
        line: {
          kind: "finding.created",
          targetId: watchedTargetId,
          id,
          text,
          dedupeKey: `finding.created:${id}:${tail(envelope.run_id)}`,
        },
      };
    }
    case "run.finished": {
      const status = escapeText(payload.status, 30);
      const fail = counterOf(payload.counters, "fail");
      if (status !== "failed" && fail <= 0) {
        return { type: "ignored" };
      }
      const id = safeId(envelope.run_id);
      const pass = counterOf(payload.counters, "pass");
      const total = counterOf(payload.counters, "scenarios_total");
      const text = `status=${status} fail=${fail} pass=${pass} of ${total}`;
      return {
        type: "line",
        line: { kind: "run.finished", targetId: watchedTargetId, id, text, dedupeKey: `run.finished:${id}` },
      };
    }
    case "generation.progress": {
      const total = counterOf(payload, "cells_total");
      const done = counterOf(payload, "cells_done");
      if (total <= 0 || done < total) {
        return { type: "ignored" };
      }
      const id = safeId(envelope.run_id ?? watchedTargetId);
      const created = counterOf(payload, "scenarios_created");
      const invalid = counterOf(payload, "scenarios_invalid");
      const text = `generation finished cells=${done}/${total} created=${created} invalid=${invalid}`;
      return {
        type: "line",
        line: {
          kind: "generation.progress",
          targetId: watchedTargetId,
          id,
          text,
          dedupeKey: `generation.progress:${id}`,
        },
      };
    }
    case "proposal.updated": {
      if (payload.status !== "selected" || typeof payload.item_id !== "string") {
        return { type: "ignored" };
      }
      const id = safeId(payload.item_id);
      const targetId = typeof payload.target_id === "string" ? safeId(payload.target_id) : watchedTargetId;
      const text = `proposal item ticked by the team proposal=${safeId(payload.proposal_id)}`;
      return {
        type: "line",
        line: {
          kind: "proposal.updated",
          targetId,
          id,
          text,
          dedupeKey: `proposal.updated:${id}:${tail(envelope.ts)}`,
        },
      };
    }
    case "coverage.updated": {
      const targetId = typeof payload.target_id === "string" ? safeId(payload.target_id) : watchedTargetId;
      return {
        type: "coverage",
        signal: {
          targetId,
          planId: typeof payload.plan_id === "string" ? safeId(payload.plan_id) : null,
          reason: escapeText(payload.reason, 30),
          dedupeKey: `coverage.updated:${targetId}:${tail(envelope.ts)}`,
        },
      };
    }
    default:
      return { type: "ignored" };
  }
}

export function coverageLine(signal: CoverageSignal, before: number, after: number): InboxLine {
  return {
    kind: "coverage.updated",
    targetId: signal.targetId,
    id: signal.planId ?? signal.targetId,
    text: `needs_author grew from ${before} to ${after} reason=${signal.reason || "unknown"}`,
    dedupeKey: signal.dedupeKey,
  };
}
