import type { StepContent } from "../simulation/step-content";
import type { DbCheck, GoldPoint, SseStepEvent, Tier0Result } from "@/lib/api/types";
import { ORACLE_RESULT_IDS } from "./oracle-templates";
import { registerStepFixtureGroup, type StepFixture } from "./steps";

export const TRUTH_READ_GROUP = "truth-read";
export const TRUTH_WRITE_GROUP = "truth-write";

const API_BASE = "https://gracie-api.qa.example.test";
const AUTHORIZATION = "Bearer ${GRACIE_ADMIN_TOKEN}";
const PASSED: Tier0Result = { passed: true, failures: [] };
const TOKEN_GAP_MS = 90;
const FIRST_TOKEN_MS = 320;

function chunks(text: string): string[] {
  const words = text.split(" ");
  const parts: string[] = [];
  for (let index = 0; index < words.length; index += 4) {
    parts.push(`${words.slice(index, index + 4).join(" ")} `);
  }
  return parts;
}

function streamEvents(answer: string | null): SseStepEvent[] {
  if (answer === null) {
    return [];
  }
  const events: SseStepEvent[] = chunks(answer).map((text, index) => ({
    event: "token",
    data: JSON.stringify({ text }),
    at_ms: FIRST_TOKEN_MS + index * TOKEN_GAP_MS,
  }));
  events.push({
    event: "done",
    data: "{}",
    at_ms: FIRST_TOKEN_MS + events.length * TOKEN_GAP_MS,
  });
  return events;
}

interface ChatStepInput {
  ask: string;
  answer: string | null;
  latencyMs: number;
  goldPoints?: GoldPoint[];
  dbChecks?: DbCheck[];
}

function chatStep(name: string, input: ChatStepInput): StepFixture {
  const { ask, answer, latencyMs, goldPoints, dbChecks } = input;
  const content: StepContent = {
    adapter: "sse",
    label: ask,
    request: {
      kind: "sse",
      method: "POST",
      url: `${API_BASE}/api/v1/chat`,
      headers: {
        Authorization: AUTHORIZATION,
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      },
      query: null,
      body: { message: ask },
    },
    response: {
      kind: "sse",
      status: 200,
      events: streamEvents(answer),
      closed_by: answer === null ? "timeout" : "server",
    },
    response_truncated: false,
    payload_purged: false,
    ask,
    answer,
    tools: [],
    cards: [],
    latency_ms: latencyMs,
    cost_usd: 0,
    tier0: PASSED,
    ok: answer !== null,
    artifacts: [],
    verdict: null,
    gold_points: goldPoints ?? [],
    db_checks: dbChecks ?? [],
  };
  return { name, content };
}

function gold(key: string, value: unknown, rendered: string, resultId: string): GoldPoint {
  return { key, value, rendered, oracle_result_id: resultId };
}

const OPEN_MAINTENANCE = ORACLE_RESULT_IDS.openMaintenanceOk;
const ISSUE_DETAIL = ORACLE_RESULT_IDS.issueDetailOk;
const FAILED_ORACLE = ORACLE_RESULT_IDS.openMaintenanceError;

const READ_STEPS: StepFixture[] = [
  chatStep("truthGoldMixed", {
    ask: "Which maintenance issues are still open?",
    answer:
      "There are 4 maintenance issues still open. The newest is the leaking pipe in room 412, assigned to Maya Rossi.",
    latencyMs: 1660,
    goldPoints: [
      gold("open_count", 4, "4", OPEN_MAINTENANCE),
      gold("newest_room", "412", "412", OPEN_MAINTENANCE),
      gold("newest_assignee", "Maya Rossi", "Maya Rossi", OPEN_MAINTENANCE),
      gold("unassigned_room", "208", "208", OPEN_MAINTENANCE),
      gold("oldest_issue_id", 1027, "1027", OPEN_MAINTENANCE),
    ],
  }),
  chatStep("truthGoldMissing", {
    ask: "How many maintenance issues are open in total?",
    answer: "I could not find any maintenance issues that are open right now.",
    latencyMs: 1240,
    goldPoints: [
      gold("open_count", 4, "4", OPEN_MAINTENANCE),
      gold("newest_room", "412", "412", OPEN_MAINTENANCE),
    ],
  }),
  chatStep("truthGoldRepeated", {
    ask: "Tell me about the leaking pipe",
    answer:
      "Room 412 has a leaking pipe. A plumber is assigned to room 412 and the fix is planned for tomorrow.",
    latencyMs: 1480,
    goldPoints: [
      gold("newest_room", "412", "412", OPEN_MAINTENANCE),
      gold("category", "plumbing", "plumbing", OPEN_MAINTENANCE),
    ],
  }),
  chatStep("truthGoldNoAnswer", {
    ask: "What is the status of issue 1042?",
    answer: null,
    latencyMs: 30000,
    goldPoints: [gold("issue_status", "open", "open", ISSUE_DETAIL)],
  }),
];

const CLOSED_EXPECTED = { status: "closed", closed_at: "not null" };

const WRITE_STEPS: StepFixture[] = [
  chatStep("truthDbPass", {
    ask: "Yes, close issue 1042",
    answer: "Issue 1042 is now closed.",
    latencyMs: 1320,
    dbChecks: [
      {
        name: "issue_1042_closed",
        expected: CLOSED_EXPECTED,
        actual: { status: "closed", closed_at: "2026-10-02T09:31:12.000Z" },
        oracle_result_id: ISSUE_DETAIL,
        status: "pass",
      },
      {
        name: "no_other_issue_changed",
        expected: { changed_rows: 1 },
        actual: { changed_rows: 1 },
        oracle_result_id: null,
        status: "pass",
      },
    ],
  }),
  chatStep("truthDbFail", {
    ask: "Yes, close issue 1039",
    answer: "Issue 1039 is closed.",
    latencyMs: 1180,
    dbChecks: [
      {
        name: "issue_1039_closed",
        expected: CLOSED_EXPECTED,
        actual: { status: "open", closed_at: null },
        oracle_result_id: ISSUE_DETAIL,
        status: "fail",
      },
    ],
  }),
  chatStep("truthDbUncertain", {
    ask: "Yes, close issue 1031",
    answer: "Issue 1031 is closed.",
    latencyMs: 1390,
    dbChecks: [
      {
        name: "audit_row_written",
        expected: { rows: 1 },
        actual: null,
        oracle_result_id: FAILED_ORACLE,
        status: "uncertain",
      },
    ],
  }),
  chatStep("truthDbMixed", {
    ask: "Yes, close issue 1027 and tell me the room",
    answer: "Issue 1027 is closed. It was in room 118.",
    latencyMs: 1510,
    goldPoints: [gold("room", "118", "118", OPEN_MAINTENANCE)],
    dbChecks: [
      {
        name: "issue_1027_closed",
        expected: CLOSED_EXPECTED,
        actual: { status: "closed", closed_at: "2026-10-02T09:44:03.000Z" },
        oracle_result_id: ISSUE_DETAIL,
        status: "pass",
      },
      {
        name: "notification_sent",
        expected: { sent: true },
        actual: { sent: false },
        oracle_result_id: null,
        status: "fail",
      },
      {
        name: "audit_row_written",
        expected: { rows: 1 },
        actual: null,
        oracle_result_id: FAILED_ORACLE,
        status: "uncertain",
      },
      {
        name: "refund_row_untouched",
        expected: { rows: 0 },
        actual: null,
        oracle_result_id: null,
        status: "skipped",
      },
    ],
  }),
];

registerStepFixtureGroup({
  key: TRUTH_READ_GROUP,
  cell: {
    feature_id: "smart_log.read.open_maintenance",
    role: "housekeeping_lead",
    interface_id: "chat_sse",
  },
  attempts: [{ outcome: "pass", steps: READ_STEPS }],
});

registerStepFixtureGroup({
  key: TRUTH_WRITE_GROUP,
  cell: {
    feature_id: "smart_log.write.close_issue",
    role: "housekeeping_lead",
    interface_id: "chat_sse",
  },
  attempts: [{ outcome: "fail", steps: WRITE_STEPS }],
});
