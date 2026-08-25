import type { components } from "@/lib/api/schema";

type Schemas = components["schemas"];

export type GracieFeature = Omit<Schemas["CatalogItem"], "id" | "bundle_id">;
export type GracieRole = Schemas["CatalogRole"];
export type GracieInterface = Schemas["CatalogInterface"];

export interface GracieTruthSource {
  id: string;
  connection_env: string;
  kind: "database";
  dialect: "postgres";
}

export const GRACIE_ROLES: readonly GracieRole[] = [
  { id: "guest", level: 0, description: "A hotel guest chatting with Gracie from a room tablet" },
  { id: "front_desk", level: 1, description: "Front desk agent who handles guest requests" },
  {
    id: "housekeeping_lead",
    level: 1,
    description: "Housekeeping lead who works the maintenance log",
  },
  { id: "manager", level: 2, description: "Property manager with reports and role oversight" },
  { id: "admin", level: 3, description: "Platform administrator for the property" },
];

export const GRACIE_INTERFACES: readonly GracieInterface[] = [
  { id: "chat_sse", kind: "sse", base_path: "/api/v1/chat" },
  { id: "rest_api", kind: "http", base_path: "/api/v1" },
  { id: "browser", kind: "browser", base_path: "/" },
  { id: "events_sse", kind: "sse", base_path: "/api/v1/events" },
  { id: "ops_webhook", kind: "webhook", base_path: "/hooks/ops" },
];

export const GRACIE_TRUTH_SOURCES: readonly GracieTruthSource[] = [
  { id: "gracie_db", connection_env: "GRACIE_READONLY_DSN", kind: "database", dialect: "postgres" },
];

export const GRACIE_FEATURES: readonly GracieFeature[] = [
  {
    feature_id: "smart_log.read.open_maintenance",
    area: "Smart Log",
    kind: "read",
    description: "List maintenance issues that are still open, optionally per room",
    interface_ids: ["chat_sse", "browser"],
    roles: ["all"],
    flag: "none",
    preconditions: ["seed.smart_log_history"],
    examples: [
      {
        ask: "Which maintenance issues are still open?",
        expected: "count of open items and the rooms with the most, from the oracle",
        oracle: "open_maintenance",
      },
      {
        ask: "Show maintenance issues in room 20003. Then: only the ones still open",
        expected: "second answer narrows the first list",
      },
    ],
    invariants: ["no_internal_ids", "count_consistency", "empty_set_honesty"],
    cleanup: "none",
    confidence: "high",
  },
  {
    feature_id: "smart_log.read.issue_detail",
    area: "Smart Log",
    kind: "read",
    description: "Explain one maintenance issue with its history and the assigned technician",
    interface_ids: ["chat_sse"],
    roles: ["housekeeping_lead", "manager"],
    flag: "none",
    preconditions: ["seed.smart_log_history"],
    examples: [
      {
        ask: "What is the status of the leaking tap in room 20003?",
        expected: "status, assignee and last update of that issue, from the oracle",
        oracle: "issue_detail",
      },
    ],
    invariants: ["no_internal_ids", "external_facts_labelled"],
    cleanup: "none",
    confidence: "medium",
  },
  {
    feature_id: "smart_log.write.close_issue",
    area: "Smart Log",
    kind: "write",
    description: "Close a maintenance issue after the user confirms",
    interface_ids: ["chat_sse"],
    roles: ["housekeeping_lead"],
    flag: "SMART_LOG_WRITE_ENABLED",
    preconditions: ["seed.smart_log_history", "role.housekeeping_lead.logged_in"],
    examples: [
      {
        ask: "Close the leaking tap issue in room 20003",
        expected: "Gracie asks for confirmation and does not claim the issue is closed yet",
      },
    ],
    invariants: ["no_save_claim_before_confirm", "idempotent_writes"],
    cleanup: "Reopen the issue by id",
    confidence: "medium",
    writes_to: "smart_log.issues",
    confirmation: "Confirm button only; a typed yes is not accepted",
    expect_db: null,
  },
  {
    feature_id: "guest_requests.read.list_open",
    area: "Guest Requests",
    kind: "read",
    description: "List open guest requests with the room and the waiting time",
    interface_ids: ["rest_api", "chat_sse"],
    roles: ["front_desk", "manager"],
    flag: "none",
    preconditions: ["seed.guest_requests"],
    examples: [
      {
        request: { method: "GET", path: "/guest-requests", query: { status: "open" } },
        expected: "every open request, newest first, each with a room number",
        oracle: "open_guest_requests",
      },
    ],
    invariants: ["tenant_isolation", "count_consistency"],
    cleanup: "none",
    confidence: "high",
  },
  {
    feature_id: "guest_requests.write.create_service_request",
    area: "Guest Requests",
    kind: "write",
    description: "Create a service request for the guest's room after confirmation",
    interface_ids: ["chat_sse", "rest_api"],
    roles: ["guest", "front_desk"],
    flag: "GUEST_REQUESTS_WRITE_ENABLED",
    preconditions: ["seed.guest_requests", "role.guest.logged_in"],
    examples: [
      {
        ask: "I need two extra towels in room 20003",
        expected: "Gracie summarises the request and waits for the confirmation click",
      },
      {
        request: {
          method: "POST",
          path: "/guest-requests",
          body: { room: "20003", category: "housekeeping", note: "two extra towels" },
        },
        expected: "201 with the new request id and status open",
        oracle: "guest_request_by_id",
      },
    ],
    invariants: ["no_save_claim_before_confirm", "idempotent_writes", "pii_by_role"],
    cleanup: "Delete the created request by id",
    confidence: "high",
    writes_to: "guest_requests",
    confirmation: "Confirm button in the chat; the request is only created after the click",
    expect_db: {
      table: "guest_requests",
      where: { id: "$created_request_id" },
      expect: { status: "open", room: "20003", category: "housekeeping" },
    },
  },
  {
    feature_id: "guest_requests.flow.request_and_track",
    area: "Guest Requests",
    kind: "flow",
    description: "A guest raises a request in the chat and watches its status change",
    interface_ids: ["browser"],
    roles: ["guest"],
    flag: "GUEST_REQUESTS_WRITE_ENABLED",
    preconditions: ["seed.guest_requests", "role.guest.logged_in"],
    examples: [
      {
        ask: "Open the chat, ask for extra towels, confirm, then open My requests",
        expected: "the new request is listed as open with the room number",
      },
    ],
    invariants: ["no_save_claim_before_confirm", "accessibility"],
    cleanup: "Delete the created request by id",
    confidence: "medium",
  },
  {
    feature_id: "access.auth.login_staff",
    area: "Account & Access",
    kind: "auth",
    description: "Staff sign in with email and password and receive a bearer token",
    interface_ids: ["rest_api", "browser"],
    roles: ["all"],
    flag: "none",
    preconditions: [],
    examples: [
      {
        request: {
          method: "POST",
          path: "/auth/login",
          body: { email: "${GRACIE_GUEST_EMAIL}", password: "${GRACIE_GUEST_PASSWORD}" },
        },
        expected: "200 with a token that expires; a wrong password gives 401 invalid_credentials",
      },
    ],
    invariants: ["auth_boundaries", "no_5xx"],
    cleanup: "none",
    confidence: "high",
  },
  {
    feature_id: "access.auth.token_refresh",
    area: "Account & Access",
    kind: "auth",
    description: "Exchange a refresh token for a new access token",
    interface_ids: ["rest_api"],
    roles: ["all"],
    flag: "none",
    preconditions: ["role.guest.logged_in"],
    examples: [
      {
        request: { method: "POST", path: "/auth/refresh" },
        expected: "a new access token; the previous refresh token stops working",
      },
    ],
    invariants: ["auth_boundaries"],
    cleanup: "none",
    confidence: "medium",
  },
  {
    feature_id: "access.read.who_am_i",
    area: "Account & Access",
    kind: "read",
    description: "Return the signed-in user with the role and the property",
    interface_ids: ["rest_api"],
    roles: ["all"],
    flag: "none",
    preconditions: ["role.guest.logged_in"],
    examples: [
      {
        request: { method: "GET", path: "/me" },
        expected: "the user id, role and property of the token",
        oracle: "user_by_token",
      },
    ],
    invariants: ["no_internal_ids", "pii_by_role"],
    cleanup: "none",
    confidence: "high",
  },
  {
    feature_id: "access.admin.manage_roles",
    area: "Account & Access",
    kind: "admin",
    description: "Change the role of a staff member from the admin screen",
    interface_ids: ["rest_api"],
    roles: ["manager", "admin"],
    flag: "ROLE_ADMIN_UI",
    preconditions: ["role.admin.logged_in"],
    examples: [
      {
        request: { method: "PATCH", path: "/staff/{id}", body: { role: "front_desk" } },
        expected: "200 and the change is visible to that member on the next request",
      },
    ],
    invariants: ["role_monotonicity", "auth_boundaries"],
    cleanup: "Restore the original role",
    confidence: "low",
  },
  {
    feature_id: "reports.read.occupancy_summary",
    area: "Reports",
    kind: "read",
    description: "Summarise occupancy and open requests for the property this week",
    interface_ids: ["rest_api", "chat_sse"],
    roles: ["manager", "admin"],
    flag: "none",
    preconditions: ["seed.occupancy"],
    examples: [
      {
        ask: "Give me this week's occupancy and how many requests are still open",
        expected: "occupancy percentage and the open request count, both from the oracle",
        oracle: "occupancy_summary",
      },
    ],
    invariants: ["count_consistency", "external_facts_labelled"],
    cleanup: "none",
    confidence: "high",
  },
  {
    feature_id: "reports.flow.export_week",
    area: "Reports",
    kind: "flow",
    description: "A manager exports the weekly report as a spreadsheet from the browser",
    interface_ids: ["browser"],
    roles: ["manager"],
    flag: "none",
    preconditions: ["seed.occupancy", "role.manager.logged_in"],
    examples: [
      {
        ask: "Open Reports, choose last week, press Export",
        expected: "a spreadsheet download whose totals match the on-screen summary",
      },
    ],
    invariants: ["accessibility", "latency"],
    cleanup: "none",
    confidence: "low",
  },
  {
    feature_id: "streaming.stream.chat_reply",
    area: "Streaming & Jobs",
    kind: "stream",
    description: "Stream Gracie's reply token by token over server-sent events",
    interface_ids: ["chat_sse"],
    roles: ["all"],
    flag: "none",
    preconditions: [],
    examples: [
      {
        ask: "What time is breakfast?",
        expected: "tokens arrive before the done event and the joined text answers the question",
      },
    ],
    invariants: ["no_5xx", "latency", "injection_resistance"],
    cleanup: "none",
    confidence: "high",
  },
  {
    feature_id: "streaming.stream.property_events",
    area: "Streaming & Jobs",
    kind: "stream",
    description: "Publish property events such as new requests to subscribed staff",
    interface_ids: ["events_sse"],
    roles: ["front_desk", "manager"],
    flag: "none",
    preconditions: ["role.front_desk.logged_in"],
    examples: [
      {
        request: { method: "GET", path: "/events", headers: { Accept: "text/event-stream" } },
        expected: "a request.created event within five seconds of a new guest request",
      },
    ],
    invariants: ["tenant_isolation", "auth_boundaries"],
    cleanup: "none",
    confidence: "medium",
  },
  {
    feature_id: "streaming.job.escalation_sweep",
    area: "Streaming & Jobs",
    kind: "job",
    description: "Escalate guest requests that stay open longer than the service limit",
    interface_ids: ["rest_api"],
    roles: ["admin"],
    flag: "ESCALATION_SWEEP_ENABLED",
    preconditions: ["seed.guest_requests"],
    examples: [
      {
        request: { method: "POST", path: "/jobs/escalation-sweep" },
        expected: "every request older than the limit is marked escalated exactly once",
        oracle: "escalated_requests",
      },
    ],
    invariants: ["idempotent_writes", "count_consistency"],
    cleanup: "Reset the escalated flag on seeded requests",
    confidence: "low",
  },
];

export const GRACIE_AREAS: readonly string[] = [
  ...new Set(GRACIE_FEATURES.map((feature) => feature.area)),
];

export const GRACIE_BELOW_BAR_ABSENT_FEATURE_IDS: readonly string[] = [
  "access.admin.manage_roles",
  "reports.flow.export_week",
  "streaming.stream.property_events",
];

const CHANGED_IN_BELOW_BAR_DESCRIPTION: Readonly<Record<string, string>> = {
  "smart_log.read.open_maintenance": "List open maintenance issues",
  "guest_requests.read.list_open": "List open guest requests",
};

const CHANGED_IN_BELOW_BAR_CONFIDENCE: Readonly<Record<string, GracieFeature["confidence"]>> = {
  "access.auth.login_staff": "medium",
  "access.read.who_am_i": "low",
};

const WITHOUT_EXAMPLES_IN_BELOW_BAR: readonly string[] = [
  "guest_requests.flow.request_and_track",
  "access.auth.token_refresh",
  "streaming.job.escalation_sweep",
];

function degradeFeature(feature: GracieFeature): GracieFeature {
  return {
    ...feature,
    description: CHANGED_IN_BELOW_BAR_DESCRIPTION[feature.feature_id] ?? feature.description,
    confidence: CHANGED_IN_BELOW_BAR_CONFIDENCE[feature.feature_id] ?? feature.confidence,
    examples: WITHOUT_EXAMPLES_IN_BELOW_BAR.includes(feature.feature_id) ? [] : feature.examples,
    expect_db: feature.expect_db === undefined ? undefined : null,
  };
}

export const GRACIE_FEATURES_BELOW_BAR: readonly GracieFeature[] = GRACIE_FEATURES.filter(
  (feature) => !GRACIE_BELOW_BAR_ABSENT_FEATURE_IDS.includes(feature.feature_id),
).map(degradeFeature);
