import type { AttemptOutcome } from "../simulation/drafts";
import type { StepContent } from "../simulation/step-content";
import type { ArtifactSpec } from "../stage2/types";
import type { Tier0Failure, Tier0Result } from "@/lib/api/types";

export interface StepFixture {
  name: string;
  content: StepContent;
}

export interface FixtureAttempt {
  outcome: AttemptOutcome;
  steps: StepFixture[];
}

export interface StepFixtureGroup {
  key: string;
  cell: { feature_id: string; role: string; interface_id: string };
  attempts: FixtureAttempt[];
}

const registry: StepFixtureGroup[] = [];

function sameCell(left: StepFixtureGroup["cell"], right: StepFixtureGroup["cell"]): boolean {
  return (
    left.feature_id === right.feature_id &&
    left.role === right.role &&
    left.interface_id === right.interface_id
  );
}

export function registerStepFixtureGroup(group: StepFixtureGroup): void {
  const clash = registry.find(
    (entry) => entry.key !== group.key && sameCell(entry.cell, group.cell),
  );
  if (clash !== undefined) {
    throw new Error(
      `step fixture group ${group.key} uses the cell of group ${clash.key}; a run holds one run scenario per cell`,
    );
  }
  const index = registry.findIndex((entry) => entry.key === group.key);
  if (index >= 0) {
    registry.splice(index, 1, group);
    return;
  }
  registry.push(group);
}

export function unregisterStepFixtureGroup(key: string): void {
  const index = registry.findIndex((entry) => entry.key === key);
  if (index >= 0) {
    registry.splice(index, 1);
  }
}

export function stepFixtureGroups(): readonly StepFixtureGroup[] {
  return registry;
}

const API_BASE = "https://gracie-api.qa.example.test";
const WEB_BASE = "https://gracie-web.qa.example.test";
const AUTHORIZATION = "Bearer ${GRACIE_ADMIN_TOKEN}";

const PASSED: Tier0Result = { passed: true, failures: [] };

function failedTier0(failures: Tier0Failure[]): Tier0Result {
  return { passed: false, failures };
}

const BROWSER_ARTIFACTS: ArtifactSpec[] = [
  { kind: "screenshot", fixture: "png", key: "shot" },
  { kind: "recording", fixture: "webm" },
  { kind: "trace", fixture: "zip" },
];

function browserArtifacts(screenshots = 1): ArtifactSpec[] {
  const shots: ArtifactSpec[] = Array.from({ length: screenshots }, (_, index) => ({
    kind: "screenshot",
    fixture: "png",
    key: `shot-${index}`,
  }));
  return [...shots, ...BROWSER_ARTIFACTS.filter((spec) => spec.kind !== "screenshot")];
}

function base(): Pick<
  StepContent,
  | "response_truncated"
  | "payload_purged"
  | "ask"
  | "answer"
  | "tools"
  | "cards"
  | "cost_usd"
  | "ok"
  | "verdict"
  | "tier0"
  | "artifacts"
> {
  return {
    response_truncated: false,
    payload_purged: false,
    ask: null,
    answer: null,
    tools: [],
    cards: [],
    cost_usd: 0,
    ok: true,
    verdict: null,
    tier0: PASSED,
    artifacts: [],
  };
}

const OPEN_ISSUES_ANSWER =
  "There are 7 maintenance issues still open. Rooms 20003 (3 issues), 20011 (2) and 10407 (2) have the most. The three oldest are listed below.";

const CHAT_STEPS: StepFixture[] = [
  {
    name: "sseAnswer",
    content: {
      ...base(),
      adapter: "sse",
      label: "Which maintenance issues are still open?",
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
        body: { message: "Which maintenance issues are still open?" },
      },
      response: {
        kind: "sse",
        status: 200,
        events: [
          {
            event: "tool_call",
            data: '{"name":"list_maintenance_issues","args":{"status":"open"}}',
            at_ms: 240,
          },
          { event: "token", data: '{"text":"There are 7 maintenance issues "}', at_ms: 610 },
          { event: "token", data: '{"text":"still open. Rooms 20003 (3 issues), "}', at_ms: 700 },
          { event: "token", data: '{"text":"20011 (2) and 10407 (2) have the most."}', at_ms: 790 },
          {
            event: "card",
            data: '{"kind":"list","title":"Open issues","rows":3}',
            at_ms: 860,
          },
          { event: "done", data: "{}", at_ms: 920 },
        ],
        closed_by: "server",
      },
      ask: "Which maintenance issues are still open?",
      answer: OPEN_ISSUES_ANSWER,
      tools: [
        {
          name: "list_maintenance_issues",
          args: { status: "open", limit: 20 },
          result_summary: "7 rows",
        },
      ],
      cards: [
        {
          kind: "list",
          title: "Open issues",
          rows: [
            { room: "20003", issue: "Leaking tap", opened: "2026-10-01" },
            { room: "20011", issue: "Broken blind", opened: "2026-10-02" },
            { room: "10407", issue: "Air conditioning noise", opened: "2026-10-03" },
          ],
        },
      ],
      latency_ms: 1840,
    },
  },
  {
    name: "sseTier0Failures",
    content: {
      ...base(),
      adapter: "sse",
      label: "Show maintenance issues in room 20003, then only the open ones",
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
        body: { message: "Show maintenance issues in room 20003. Then: only the ones still open" },
      },
      response: {
        kind: "sse",
        status: 200,
        events: [
          {
            event: "token",
            data: '{"text":"Issue 8c1f2e44-5d0b-4a3f-9d6e-0b7a6c1d2e90 is "}',
            at_ms: 410,
          },
          { event: "token", data: '{"text":"assigned to nobody."}', at_ms: 520 },
          { event: "done", data: "{}", at_ms: 580 },
        ],
        closed_by: "server",
      },
      ask: "Show maintenance issues in room 20003. Then: only the ones still open",
      answer: "Issue 8c1f2e44-5d0b-4a3f-9d6e-0b7a6c1d2e90 is assigned to nobody.",
      latency_ms: 960,
      tier0: failedTier0([
        {
          check: "text_contains",
          message: "The answer does not mention room 20003",
          expected: "20003",
          actual: "Issue 8c1f2e44-5d0b-4a3f-9d6e-0b7a6c1d2e90 is assigned to nobody.",
        },
        {
          check: "tools",
          message: "The expected tool list_maintenance_issues was not called",
          expected: ["list_maintenance_issues"],
          actual: [],
        },
        {
          check: "internal_ids",
          message: "The answer shows an internal identifier",
          expected: null,
          actual: "8c1f2e44-5d0b-4a3f-9d6e-0b7a6c1d2e90",
        },
        {
          check: "cards",
          message: "Expected at least one card, got none",
          expected: { min_count: 1 },
          actual: { count: 0 },
        },
      ]),
    },
  },
  {
    name: "sseTruncated",
    content: {
      ...base(),
      adapter: "sse",
      label: "Explain the history of the leaking tap in room 20003",
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
        body: { message: "Explain the history of the leaking tap in room 20003" },
      },
      response: {
        kind: "sse",
        status: 200,
        events: [
          { event: "token", data: '{"text":"The tap was reported on 1 October. "}', at_ms: 350 },
          { event: "token", data: '{"text":"A technician visited twice. "}', at_ms: 470 },
          { event: "truncated", data: "stored payload cut at 262144 bytes", at_ms: 5120 },
        ],
        closed_by: "limit",
      },
      response_truncated: true,
      ask: "Explain the history of the leaking tap in room 20003",
      answer: "The tap was reported on 1 October. A technician visited twice. ...",
      latency_ms: 5120,
      tier0: failedTier0([
        {
          check: "latency",
          message: "The stream did not finish within 3000 ms",
          expected: 3000,
          actual: 5120,
        },
      ]),
    },
  },
  {
    name: "sseTimeout",
    content: {
      ...base(),
      adapter: "sse",
      label: "What time is breakfast?",
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
        body: { message: "What time is breakfast?" },
      },
      response: { kind: "sse", status: 200, events: [], closed_by: "timeout" },
      ask: "What time is breakfast?",
      answer: null,
      ok: false,
      latency_ms: 30000,
      tier0: failedTier0([
        {
          check: "latency",
          message: "The stream sent no event before the 30000 ms timeout",
          expected: 3000,
          actual: 30000,
        },
      ]),
    },
  },
];

const REST_STEPS: StepFixture[] = [
  {
    name: "httpJson",
    content: {
      ...base(),
      adapter: "http",
      label: "GET /api/v1/guest-requests?status=open",
      request: {
        kind: "http",
        method: "GET",
        url: `${API_BASE}/api/v1/guest-requests`,
        headers: { Authorization: AUTHORIZATION, Accept: "application/json" },
        query: { status: "open" },
        body: null,
      },
      response: {
        kind: "http",
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "req-7f31c0a2" },
        body: {
          items: [
            {
              id: "gr_1042",
              room: "20003",
              category: "housekeeping",
              status: "open",
              waiting_minutes: 42,
            },
            {
              id: "gr_1043",
              room: "20011",
              category: "maintenance",
              status: "open",
              waiting_minutes: 17,
            },
          ],
          total: 2,
        },
        body_text: null,
      },
      latency_ms: 142,
    },
  },
  {
    name: "httpText",
    content: {
      ...base(),
      adapter: "http",
      label: "POST /api/v1/guest-requests",
      request: {
        kind: "http",
        method: "POST",
        url: `${API_BASE}/api/v1/guest-requests`,
        headers: {
          Authorization: AUTHORIZATION,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        query: null,
        body: { room: "20003", category: "housekeeping", note: "two extra towels" },
      },
      response: {
        kind: "http",
        status: 502,
        headers: { "content-type": "text/html" },
        body: null,
        body_text:
          "<html><head><title>502 Bad Gateway</title></head><body>Bad Gateway</body></html>",
      },
      latency_ms: 63,
      tier0: failedTier0([
        {
          check: "status",
          message: "Expected status 201, got 502",
          expected: 201,
          actual: 502,
        },
        {
          check: "schema",
          message: "The response body is not JSON",
          expected: "application/json",
          actual: "text/html",
        },
      ]),
    },
  },
  {
    name: "httpPurged",
    content: {
      ...base(),
      adapter: "http",
      label: "GET /api/v1/me",
      request: null,
      response: null,
      payload_purged: true,
      latency_ms: 88,
    },
  },
  {
    name: "httpServerError",
    content: {
      ...base(),
      adapter: "http",
      label: "POST /api/v1/jobs/escalation-sweep",
      request: {
        kind: "http",
        method: "POST",
        url: `${API_BASE}/api/v1/jobs/escalation-sweep`,
        headers: { Authorization: AUTHORIZATION, Accept: "application/json" },
        query: null,
        body: null,
      },
      response: {
        kind: "http",
        status: 500,
        headers: { "content-type": "application/json" },
        body: { error: { code: "internal_error", message: "Internal server error" } },
        body_text: null,
      },
      latency_ms: 4210,
      tier0: failedTier0([
        { check: "status", message: "Expected status 200, got 500", expected: 200, actual: 500 },
        {
          check: "fields",
          message: "The body has no field escalated",
          expected: { path: "escalated", exists: true },
          actual: null,
        },
        { check: "latency", message: "The response took 4210 ms", expected: 3000, actual: 4210 },
      ]),
    },
  },
  {
    name: "httpTruncated",
    content: {
      ...base(),
      adapter: "http",
      label: "GET /api/v1/guest-requests?limit=5000",
      request: {
        kind: "http",
        method: "GET",
        url: `${API_BASE}/api/v1/guest-requests`,
        headers: { Authorization: AUTHORIZATION, Accept: "application/json" },
        query: { limit: 5000 },
        body: null,
      },
      response: {
        kind: "http",
        status: 200,
        headers: { "content-type": "application/json", "content-length": "1843921" },
        body: {
          items: [{ id: "gr_0001", room: "10101", status: "closed" }],
          truncated_note: "stored payload cut at 262144 bytes",
        },
        body_text: null,
      },
      response_truncated: true,
      latency_ms: 910,
    },
  },
];

const BROWSER_STEPS: StepFixture[] = [
  {
    name: "browserNavigate",
    content: {
      ...base(),
      adapter: "browser",
      label: "Open the sign-in page",
      request: {
        kind: "browser",
        action: "navigate",
        target: null,
        text: null,
        url: `${WEB_BASE}/login`,
      },
      response: {
        kind: "browser",
        url: `${WEB_BASE}/login`,
        title: "Sign in | Gracie",
        text_excerpt: "Sign in to Gracie. Email. Password. Forgot your password?",
        console: [{ level: "warning", text: "Deprecated API used: webkitStorageInfo" }],
        dom_state: { text_found: { "Sign in": true }, elements: { 'button "Sign in"': "visible" } },
      },
      latency_ms: 620,
      artifacts: browserArtifacts(),
    },
  },
  {
    name: "browserType",
    content: {
      ...base(),
      adapter: "browser",
      label: "Fill the guest email",
      request: {
        kind: "browser",
        action: "type",
        target: 'textbox "Email"',
        text: "${GRACIE_GUEST_EMAIL}",
        url: null,
      },
      response: {
        kind: "browser",
        url: `${WEB_BASE}/login`,
        title: "Sign in | Gracie",
        text_excerpt: null,
        console: [],
        dom_state: null,
      },
      latency_ms: 190,
      artifacts: browserArtifacts(),
    },
  },
  {
    name: "browserClick",
    content: {
      ...base(),
      adapter: "browser",
      label: "Press Sign in",
      request: {
        kind: "browser",
        action: "click",
        target: 'button "Sign in"',
        text: null,
        url: null,
      },
      response: {
        kind: "browser",
        url: `${WEB_BASE}/`,
        title: "Gracie",
        text_excerpt: "Welcome back. How can I help you today?",
        console: [],
        dom_state: { text_found: { "Welcome back": true }, elements: {} },
      },
      latency_ms: 880,
      artifacts: browserArtifacts(2),
    },
  },
  {
    name: "browserRead",
    content: {
      ...base(),
      adapter: "browser",
      label: "Read the conversation",
      request: {
        kind: "browser",
        action: "read",
        target: 'log "Conversation"',
        text: null,
        url: null,
      },
      response: {
        kind: "browser",
        url: `${WEB_BASE}/`,
        title: "Gracie",
        text_excerpt:
          "Welcome back. How can I help you today? You: I need two extra towels in room 20003. Gracie: I can send housekeeping to room 20003 with two extra towels. Nothing has been requested yet: press Confirm to send the request. Confirm. Cancel.",
        console: [],
        dom_state: {
          text_found: { "two extra towels": true, Confirm: true },
          elements: { 'button "Confirm"': "visible", 'button "Cancel"': "visible" },
        },
      },
      latency_ms: 240,
      artifacts: browserArtifacts(),
    },
  },
  {
    name: "browserAssertFailure",
    content: {
      ...base(),
      adapter: "browser",
      label: "Assert the request is listed as open",
      request: {
        kind: "browser",
        action: "assert",
        target: 'list "My requests"',
        text: "two extra towels",
        url: null,
      },
      response: {
        kind: "browser",
        url: `${WEB_BASE}/requests`,
        title: "My requests | Gracie",
        text_excerpt: "My requests. You have no open requests.",
        console: [
          { level: "error", text: "Failed to load resource: the server responded with 500" },
          {
            level: "error",
            text: "Uncaught TypeError: Cannot read properties of undefined (reading 'map')",
          },
        ],
        dom_state: {
          text_found: { "two extra towels": false },
          elements: { 'listitem "Request"': "missing" },
        },
      },
      latency_ms: 1320,
      artifacts: browserArtifacts(),
      tier0: failedTier0([
        {
          check: "dom_state",
          message: "The page does not show the text two extra towels",
          expected: "two extra towels",
          actual: "My requests. You have no open requests.",
        },
        {
          check: "console",
          message: "The console logged 2 errors",
          expected: [],
          actual: [
            "Failed to load resource: the server responded with 500",
            "Uncaught TypeError: Cannot read properties of undefined (reading 'map')",
          ],
        },
      ]),
    },
  },
  {
    name: "browserMissingElement",
    content: {
      ...base(),
      adapter: "browser",
      label: "Press Export",
      request: {
        kind: "browser",
        action: "click",
        target: 'button "Export"',
        text: null,
        url: null,
      },
      response: {
        kind: "browser",
        url: `${WEB_BASE}/reports`,
        title: "Reports | Gracie",
        text_excerpt: "Reports. Choose a week.",
        console: [],
        dom_state: { text_found: {}, elements: { 'button "Export"': "missing" } },
      },
      ok: false,
      latency_ms: 5000,
      artifacts: browserArtifacts(),
      tier0: failedTier0([
        {
          check: "dom_state",
          message: 'The element button "Export" was not found within 5000 ms',
          expected: 'button "Export"',
          actual: null,
        },
      ]),
    },
  },
];

registerStepFixtureGroup({
  key: "chat",
  cell: {
    feature_id: "smart_log.read.open_maintenance",
    role: "guest",
    interface_id: "chat_sse",
  },
  attempts: [{ outcome: "fail", steps: CHAT_STEPS }],
});

registerStepFixtureGroup({
  key: "rest",
  cell: {
    feature_id: "guest_requests.read.list_open",
    role: "front_desk",
    interface_id: "rest_api",
  },
  attempts: [{ outcome: "fail", steps: REST_STEPS }],
});

registerStepFixtureGroup({
  key: "browser",
  cell: {
    feature_id: "guest_requests.flow.request_and_track",
    role: "guest",
    interface_id: "browser",
  },
  attempts: [{ outcome: "fail", steps: BROWSER_STEPS }],
});
