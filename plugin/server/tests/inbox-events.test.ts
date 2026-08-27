import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_LINE_CHARACTERS,
  escapeText,
  formatLine,
  interpretEvent,
  parseEnvelope,
  type InboxLine,
} from "../src/inbox-events";
import { FileInboxStore, INBOX_CAP, MemoryInboxStore, pruneStaleFiles, safeFileName } from "../src/inbox-store";
import { SseParser } from "../src/sse";
import { FINDING, ITEM, PROPOSAL, RUN, TARGET, envelope } from "./sse-stub";

function lineOf(interpretation: ReturnType<typeof interpretEvent>): InboxLine {
  if (interpretation.type !== "line") {
    throw new Error(`expected a line, got ${interpretation.type}`);
  }
  return interpretation.line;
}

function interpret(type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const parsed = parseEnvelope(JSON.stringify(envelope(type, payload, extra)));
  if (parsed === null) {
    throw new Error("envelope did not parse");
  }
  return interpretEvent(parsed, TARGET);
}

describe("escapeText", () => {
  it("turns angle brackets into entities", () => {
    const escaped = escapeText("<script>alert(1)</script> & <b>bold</b>");
    expect(escaped).not.toMatch(/[<>]/);
    expect(escaped).toContain("&lt;script&gt;");
  });

  it("removes control characters, newlines and bidi marks", () => {
    const escaped = escapeText("a\nb\r\nc\u0000d\u001be\u202ef\u2028g\ttab");
    expect(escaped).toBe("a b c d e f g tab");
  });

  it("replaces double quotes and collapses whitespace", () => {
    expect(escapeText('say   "hi"\n\n  now')).toBe("say 'hi' now");
  });

  it("cuts long text at the character limit without splitting a surrogate pair", () => {
    const escaped = escapeText("😀".repeat(500), 20);
    expect(Array.from(escaped)).toHaveLength(20);
    expect(escaped.endsWith("…")).toBe(true);
  });

  it("handles non-string values", () => {
    expect(escapeText(null)).toBe("");
    expect(escapeText(42)).toBe("42");
  });
});

describe("filter rules", () => {
  it("keeps finding.created with the finding id as the id", () => {
    const line = lineOf(
      interpret("finding.created", { finding_id: FINDING, title: "Checkout <b>fails</b>\nnow", class: "bug", severity: "high", is_new: true }, { run_id: RUN }),
    );
    expect(line.kind).toBe("finding.created");
    expect(line.id).toBe(FINDING);
    expect(line.targetId).toBe(TARGET);
    const text = formatLine(line);
    expect(text.startsWith(`kind=finding.created target=${TARGET} id=${FINDING} `)).toBe(true);
    expect(text).toContain("high bug 'Checkout &lt;b&gt;fails&lt;/b&gt; now'");
    expect(text).not.toMatch(/[<>\n\r]/);
  });

  it("marks a finding that was matched rather than new", () => {
    const line = lineOf(interpret("finding.created", { finding_id: FINDING, title: "t", class: "bug", severity: "low", is_new: false }));
    expect(line.text).toContain("already known");
  });

  it("keeps run.finished only when something failed", () => {
    const counters = (fail: number) => ({ scenarios_total: 10, scenarios_done: 10, pass: 10 - fail, fail, flaky: 0, uncertain: 0, skipped: 0, steps_recorded: 40 });
    expect(interpret("run.finished", { status: "completed", counters: counters(0) }, { run_id: RUN, seq: 9 }).type).toBe("ignored");
    const failing = lineOf(interpret("run.finished", { status: "completed", counters: counters(3) }, { run_id: RUN, seq: 9 }));
    expect(failing.id).toBe(RUN);
    expect(failing.text).toBe("status=completed fail=3 pass=7 of 10");
    const failedStatus = lineOf(interpret("run.finished", { status: "failed", counters: counters(0) }, { run_id: RUN }));
    expect(failedStatus.text).toContain("status=failed");
  });

  it("keeps generation.progress only at completion", () => {
    expect(interpret("generation.progress", { cells_total: 8, cells_done: 3, scenarios_created: 2, scenarios_invalid: 0 }, { run_id: RUN }).type).toBe("ignored");
    expect(interpret("generation.progress", { cells_total: 0, cells_done: 0, scenarios_created: 0, scenarios_invalid: 0 }, { run_id: RUN }).type).toBe("ignored");
    const done = lineOf(interpret("generation.progress", { cells_total: 8, cells_done: 8, scenarios_created: 6, scenarios_invalid: 1 }, { run_id: RUN }));
    expect(done.text).toBe("generation finished cells=8/8 created=6 invalid=1");
    expect(done.id).toBe(RUN);
  });

  it("keeps proposal.updated only when an item was selected", () => {
    expect(interpret("proposal.updated", { target_id: TARGET, proposal_id: PROPOSAL, item_id: ITEM, status: "declined" }).type).toBe("ignored");
    expect(interpret("proposal.updated", { target_id: TARGET, proposal_id: PROPOSAL, item_id: null, status: null }).type).toBe("ignored");
    const selected = lineOf(interpret("proposal.updated", { target_id: TARGET, proposal_id: PROPOSAL, item_id: ITEM, status: "selected" }));
    expect(selected.id).toBe(ITEM);
    expect(selected.kind).toBe("proposal.updated");
  });

  it("hands coverage.updated to the needs_author comparison", () => {
    const result = interpret("coverage.updated", { target_id: TARGET, plan_id: PROPOSAL, cell_ids: [], reason: "generated" });
    expect(result.type).toBe("coverage");
  });

  it("ignores every other event", () => {
    for (const type of ["finding.updated", "run.created", "run.status_changed", "scenario.changed", "dashboard.invalidate", "agent_session.changed"]) {
      expect(interpret(type, {}).type, type).toBe("ignored");
    }
  });

  it("never lets an unsafe id into a line", () => {
    const line = lineOf(interpret("finding.created", { finding_id: "x y\n<z>", title: "t", class: "bug", severity: "low" }));
    expect(line.id).toBe("unknown");
  });

  it("caps a whole line", () => {
    const line = lineOf(interpret("finding.created", { finding_id: FINDING, title: "x".repeat(5000), class: "c".repeat(5000), severity: "s".repeat(5000) }));
    expect(Array.from(formatLine(line)).length).toBeLessThanOrEqual(MAX_LINE_CHARACTERS);
  });

  it("rejects an envelope that is not an object with a type", () => {
    expect(parseEnvelope("not json")).toBeNull();
    expect(parseEnvelope("[1]")).toBeNull();
    expect(parseEnvelope('{"payload":{}}')).toBeNull();
  });
});

describe("SseParser", () => {
  it("parses frames that arrive in pieces and ignores comments", () => {
    const parser = new SseParser();
    expect(parser.push(": ping\n\nevent: a\nda")).toEqual([]);
    expect(parser.push('ta: {"x":1}\n\nevent: b\ndata: 2\n\n')).toEqual([
      { event: "a", data: '{"x":1}' },
      { event: "b", data: "2" },
    ]);
  });

  it("handles CRLF framing and multi-line data", () => {
    const parser = new SseParser();
    expect(parser.push("event: c\r\ndata: one\r\ndata: two\r\n\r\n")).toEqual([{ event: "c", data: "one\ntwo" }]);
  });

  it("refuses an endless frame", () => {
    const parser = new SseParser();
    expect(() => parser.push("data: ".padEnd(1_100_000, "x"))).toThrow();
  });
});

describe("inbox stores", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "tessa-inbox-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("keeps at most 200 lines and drops the oldest", async () => {
    const store = new FileInboxStore(join(directory, "inbox"), "session-1");
    for (let batch = 0; batch < 5; batch += 1) {
      await store.append(Array.from({ length: 50 }, (_, index) => `line-${batch * 50 + index}`), "2026-10-09T10:00:00Z");
    }
    const lines = await store.read();
    expect(lines).toHaveLength(INBOX_CAP);
    expect(lines[0]).toBe("line-50");
    expect(lines[INBOX_CAP - 1]).toBe("line-249");
  });

  it("writes one JSON object per line and reads plain lines too", async () => {
    const store = new FileInboxStore(join(directory, "inbox"), "session-2");
    await store.append(["kind=a target=t id=i hello"], "2026-10-09T10:00:00Z");
    const text = await readFile(store.path, "utf8");
    expect(JSON.parse(text.trim())).toEqual({ at: "2026-10-09T10:00:00Z", line: "kind=a target=t id=i hello" });
    await writeFile(store.path, "kind=b plain line\n", { flag: "a" });
    expect(await store.read()).toEqual(["kind=a target=t id=i hello", "kind=b plain line"]);
  });

  it("take returns the lines and leaves nothing behind", async () => {
    const store = new FileInboxStore(join(directory, "inbox"), "session-3");
    await store.append(["one", "two"], "2026-10-09T10:00:00Z");
    expect(await store.take()).toEqual(["one", "two"]);
    expect(await store.read()).toEqual([]);
    expect(await store.take()).toEqual([]);
  });

  it("serialises concurrent appends without losing a line", async () => {
    const store = new FileInboxStore(join(directory, "inbox"), "session-4");
    await Promise.all(Array.from({ length: 60 }, (_, index) => store.append([`n-${index}`], "2026-10-09T10:00:00Z")));
    expect(await store.read()).toHaveLength(60);
  });

  it("keeps a session name safe as a file name", () => {
    expect(safeFileName("../../etc/passwd")).toBe("______etc_passwd");
    expect(safeFileName("a".repeat(300))).toHaveLength(128);
  });

  it("memory store follows the same cap and take rules", async () => {
    const store = new MemoryInboxStore();
    await store.append(Array.from({ length: 230 }, (_, index) => `m-${index}`));
    expect(await store.read()).toHaveLength(INBOX_CAP);
    expect((await store.take())[0]).toBe("m-30");
    expect(await store.read()).toEqual([]);
  });

  it("prunes files older than the age limit", async () => {
    const store = new FileInboxStore(join(directory, "inbox"), "old-session");
    await store.append(["x"], "2026-10-09T10:00:00Z");
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await utimes(store.path, old, old);
    const fresh = new FileInboxStore(join(directory, "inbox"), "new-session");
    await fresh.append(["y"], "2026-10-09T10:00:00Z");
    expect(await pruneStaleFiles(directory, 7 * 24 * 60 * 60 * 1000, Date.now())).toBe(1);
    await expect(stat(store.path)).rejects.toThrow();
    expect((await stat(fresh.path)).isFile()).toBe(true);
  });
});
