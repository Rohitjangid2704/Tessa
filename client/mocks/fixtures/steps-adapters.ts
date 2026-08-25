import {
  adapterStep,
  adapterTier0Failed,
  cliStep,
  graphqlStep,
  pipelineStep,
  webhookStep,
  websocketStep,
  wirePayload,
} from "../factories/adapter-steps";
import type {
  AnyStepRequest,
  AnyStepResponse,
  WebhookOutboundCall,
  WebsocketMessage,
} from "@/lib/api/types";
import { registerStepFixtureGroup, type StepFixture } from "./steps";

export const ADAPTER_GROUPS = {
  webhook: "adapter-webhook",
  websocket: "adapter-websocket",
  graphql: "adapter-graphql",
  cli: "adapter-cli",
  pipeline: "adapter-pipeline",
  forward: "adapter-forward",
} as const;

const API_BASE = "https://gracie-api.qa.example.test";
const WS_BASE = "wss://gracie-api.qa.example.test";
const STUB_BASE = "http://host.docker.internal:7100/runs/showcase";
const PAYLOAD_HASH = "9f2c6b1e4d7a3058c1e9b6f2a4d80735e1c9a6b4f3d27180c5e9a1b7d4f60c23";
const SIGNATURE_HEADER = "X-Ops-Signature";
const NOTIFY_AUTHORIZATION = "Bearer ${OPS_NOTIFY_TOKEN}";
const MANY_CALLS = 25;
const MANY_MESSAGES = 60;
const MANY_LINES = 400;

const WEBHOOK_BODY = {
  event: "guest_request.created",
  request_id: "gr_1051",
  room: "20003",
  category: "housekeeping",
};

function outboundCall(path: string, atMs: number, body: unknown): WebhookOutboundCall {
  return {
    method: "POST",
    url: `${STUB_BASE}${path}`,
    headers: { "content-type": "application/json", Authorization: NOTIFY_AUTHORIZATION },
    body,
    received_at_ms: atMs,
  };
}

function socketMessage(atMs: number, data: unknown): WebsocketMessage {
  return { at_ms: atMs, data: JSON.stringify(data) };
}

const WEBHOOK_STEPS: StepFixture[] = [
  {
    name: "webhookDelivered",
    content: webhookStep(
      {
        kind: "webhook",
        url: `${API_BASE}/hooks/ops/guest-requests`,
        headers: {
          "Content-Type": "application/json",
          [SIGNATURE_HEADER]: `sha256=${PAYLOAD_HASH}`,
        },
        body: WEBHOOK_BODY,
        signature: {
          scheme: "hmac_sha256",
          header: SIGNATURE_HEADER,
          signed_payload_sha256: PAYLOAD_HASH,
        },
      },
      {
        kind: "webhook",
        status: 202,
        headers: { "content-type": "application/json", "x-request-id": "req-3b90c7d1" },
        body: { accepted: true },
        outbound_calls: [
          outboundCall("/notify", 180, {
            channel: "housekeeping",
            room: "20003",
            text: "Two extra towels for room 20003",
          }),
          outboundCall("/ack", 460, { delivered: true, request_id: "gr_1051" }),
        ],
      },
      { label: "Send the guest request created webhook", latencyMs: 520 },
    ),
  },
  {
    name: "webhookUnsigned",
    content: webhookStep(
      {
        kind: "webhook",
        url: `${API_BASE}/hooks/ops/guest-requests`,
        headers: { "Content-Type": "application/json" },
        body: WEBHOOK_BODY,
        signature: null,
      },
      {
        kind: "webhook",
        status: 401,
        headers: { "content-type": "application/json" },
        body: { error: { code: "invalid_signature", message: "The signature header is missing" } },
        outbound_calls: [],
      },
      {
        label: "Send the same webhook without a signature",
        latencyMs: 90,
        tier0: adapterTier0Failed([
          { check: "status", message: "Expected status 202, got 401", expected: 202, actual: 401 },
        ]),
      },
    ),
  },
  {
    name: "webhookManyCalls",
    content: webhookStep(
      {
        kind: "webhook",
        url: `${API_BASE}/hooks/ops/bulk-close`,
        headers: {
          "Content-Type": "application/json",
          [SIGNATURE_HEADER]: `sha256=${PAYLOAD_HASH}`,
        },
        body: { event: "guest_request.bulk_closed", count: MANY_CALLS },
        signature: {
          scheme: "hmac_sha256",
          header: SIGNATURE_HEADER,
          signed_payload_sha256: PAYLOAD_HASH,
        },
      },
      {
        kind: "webhook",
        status: 200,
        headers: { "content-type": "application/json" },
        body: { closed: MANY_CALLS },
        outbound_calls: Array.from({ length: MANY_CALLS }, (_, index) =>
          outboundCall(`/closed/${index + 1}`, 120 + index * 35, { sequence: index + 1 }),
        ),
      },
      { label: "Send the bulk close webhook", latencyMs: 1310 },
    ),
  },
];

const WEBSOCKET_STEPS: StepFixture[] = [
  {
    name: "websocketSession",
    content: websocketStep(
      {
        kind: "websocket",
        url: `${WS_BASE}/ws/property-events`,
        messages_sent: [
          socketMessage(0, { type: "subscribe", channel: "property_events" }),
          socketMessage(900, { type: "ping" }),
        ],
      },
      {
        kind: "websocket",
        messages_received: [
          socketMessage(120, { type: "subscribed", channel: "property_events" }),
          socketMessage(450, { type: "event", name: "issue.opened", room: "20003" }),
          socketMessage(910, { type: "pong" }),
        ],
        close_code: 1000,
        close_reason: "client closed the connection",
        truncated: false,
      },
      { label: "Subscribe to property events", latencyMs: 1040 },
    ),
  },
  {
    name: "websocketTruncated",
    content: websocketStep(
      {
        kind: "websocket",
        url: `${WS_BASE}/ws/property-events`,
        messages_sent: [socketMessage(0, { type: "subscribe", channel: "all" })],
      },
      {
        kind: "websocket",
        messages_received: Array.from({ length: MANY_MESSAGES }, (_, index) =>
          socketMessage(100 + index * 40, { type: "event", sequence: index + 1 }),
        ),
        close_code: 1006,
        close_reason: null,
        truncated: true,
      },
      {
        label: "Subscribe to every channel",
        latencyMs: 2600,
        responseTruncated: true,
        tier0: adapterTier0Failed([
          {
            check: "latency",
            message: "The connection did not close within 2000 ms",
            expected: 2000,
            actual: 2600,
          },
        ]),
      },
    ),
  },
  {
    name: "websocketNoClose",
    content: websocketStep(
      {
        kind: "websocket",
        url: `${WS_BASE}/ws/property-events`,
        messages_sent: [socketMessage(0, { type: "subscribe", channel: "guest_requests" })],
      },
      {
        kind: "websocket",
        messages_received: [],
        close_code: null,
        close_reason: null,
        truncated: false,
      },
      {
        label: "Subscribe to guest requests",
        latencyMs: 5000,
        ok: false,
        tier0: adapterTier0Failed([
          {
            check: "fields",
            message: "No message arrived within 5000 ms",
            expected: { min_messages: 1 },
            actual: { messages: 0 },
          },
        ]),
      },
    ),
  },
];

const OCCUPANCY_QUERY = `query OccupancySummary($week: String!) {
  occupancy(week: $week) {
    date
    occupied
    total
  }
}`;

const GRAPHQL_STEPS: StepFixture[] = [
  {
    name: "graphqlOk",
    content: graphqlStep(
      {
        kind: "graphql",
        url: `${API_BASE}/graphql`,
        operation_name: "OccupancySummary",
        query: OCCUPANCY_QUERY,
        variables: { week: "2026-W40" },
      },
      {
        kind: "graphql",
        status: 200,
        data: {
          occupancy: [
            { date: "2026-09-28", occupied: 112, total: 140 },
            { date: "2026-09-29", occupied: 118, total: 140 },
            { date: "2026-09-30", occupied: 121, total: 140 },
          ],
        },
        errors: [],
      },
      { label: "Read the weekly occupancy", latencyMs: 210 },
    ),
  },
  {
    name: "graphqlErrors",
    content: graphqlStep(
      {
        kind: "graphql",
        url: `${API_BASE}/graphql`,
        operation_name: "OccupancySummary",
        query: OCCUPANCY_QUERY,
        variables: { week: "2026-W41" },
      },
      {
        kind: "graphql",
        status: 200,
        data: { occupancy: null },
        errors: [
          {
            message: "Not authorised to read occupancy for property 77",
            path: ["occupancy"],
            extensions: { code: "FORBIDDEN", property_id: 77 },
          },
          {
            message: "Cannot resolve field rooms.guest on a closed room",
            path: ["occupancy", "0", "rooms", "3", "guest"],
            extensions: null,
          },
        ],
      },
      {
        label: "Read the occupancy of another property",
        latencyMs: 180,
        tier0: adapterTier0Failed([
          {
            check: "fields",
            message: "The response carried 2 GraphQL errors",
            expected: { errors: 0 },
            actual: { errors: 2 },
          },
        ]),
      },
    ),
  },
  {
    name: "graphqlAnonymous",
    content: graphqlStep(
      {
        kind: "graphql",
        url: `${API_BASE}/graphql`,
        operation_name: null,
        query: "{ occupancy(week: $week) { date } }",
        variables: null,
      },
      {
        kind: "graphql",
        status: 400,
        data: null,
        errors: [
          {
            message: 'Variable "$week" is not defined',
            path: null,
            extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
          },
        ],
      },
      {
        label: "Send an anonymous operation with a missing variable",
        latencyMs: 75,
        tier0: adapterTier0Failed([
          { check: "status", message: "Expected status 200, got 400", expected: 200, actual: 400 },
        ]),
      },
    ),
  },
];

const ESCAPE = String.fromCharCode(0x1b);
const GREEN = `${ESCAPE}[32m`;
const RED = `${ESCAPE}[1;31m`;
const RESET = `${ESCAPE}[0m`;

const CLI_STEPS: StepFixture[] = [
  {
    name: "cliSuccess",
    content: cliStep(
      {
        kind: "cli",
        argv: ["gracie-cli", "roles", "list", "--property", "77", "--format", "table"],
        cwd: "/srv/gracie",
        env_names: ["GRACIE_DB_DSN", "GRACIE_ADMIN_TOKEN"],
      },
      {
        kind: "cli",
        exit_code: 0,
        stdout: `${GREEN}OK${RESET} 5 roles found\nguest        level 0\nfront_desk   level 1\nmanager      level 2\nadmin        level 3\n`,
        stderr: "",
        truncated: false,
        duration_ms: 1840,
      },
      { label: "List the roles of property 77", latencyMs: 1860 },
    ),
  },
  {
    name: "cliFailure",
    content: cliStep(
      {
        kind: "cli",
        argv: ["gracie-cli", "roles", "grant", "--user", "o'brien", "--role", "super admin"],
        cwd: null,
        env_names: [],
      },
      {
        kind: "cli",
        exit_code: 2,
        stdout: "",
        stderr: `${RED}error:${RESET} unknown role "super admin"\nValid roles: guest, front_desk, housekeeping_lead, manager, admin\n`,
        truncated: false,
        duration_ms: 240,
      },
      {
        label: "Grant a role that does not exist",
        latencyMs: 260,
        tier0: adapterTier0Failed([
          {
            check: "text_not_contains",
            message: "The output contains the text error:",
            expected: "error:",
            actual: 'error: unknown role "super admin"',
          },
        ]),
      },
    ),
  },
  {
    name: "cliTruncated",
    content: cliStep(
      {
        kind: "cli",
        argv: ["gracie-cli", "audit", "export", "--since", "2026-01-01"],
        cwd: "/srv/gracie",
        env_names: ["GRACIE_DB_DSN"],
      },
      {
        kind: "cli",
        exit_code: 0,
        stdout: Array.from(
          { length: MANY_LINES },
          (_, index) => `${GREEN}audit${RESET} entry ${index + 1} role change recorded`,
        ).join("\n"),
        stderr: "",
        truncated: true,
        duration_ms: 5200,
      },
      { label: "Export the audit log", latencyMs: 5210, responseTruncated: true },
    ),
  },
];

const PIPELINE_MARKER = "tessa-marker-8f21";

const PIPELINE_STEPS: StepFixture[] = [
  {
    name: "pipelineIngest",
    content: pipelineStep(
      {
        kind: "pipeline",
        op: "ingest",
        marker: PIPELINE_MARKER,
        role: null,
        params: { fixture: "occupancy_week.json", records: 7 },
      },
      {
        kind: "pipeline",
        op: "ingest",
        ok: true,
        expected: { records: 7 },
        observed: { records: 7 },
      },
      { label: "Ingest the occupancy fixture", latencyMs: 640 },
    ),
  },
  {
    name: "pipelineIndexMismatch",
    content: pipelineStep(
      {
        kind: "pipeline",
        op: "assert_index",
        marker: PIPELINE_MARKER,
        role: null,
        params: { index: "occupancy", expect_count: 7 },
      },
      {
        kind: "pipeline",
        op: "assert_index",
        ok: false,
        expected: { doc_count: 7, fields: ["date", "occupied", "total"] },
        observed: { doc_count: 6, fields: ["date", "occupied"] },
      },
      {
        label: "Check the occupancy index holds the fixture",
        latencyMs: 380,
        tier0: adapterTier0Failed([
          {
            check: "fields",
            message: "The index holds 6 documents, expected 7",
            expected: { doc_count: 7 },
            actual: { doc_count: 6 },
          },
        ]),
      },
    ),
  },
  {
    name: "pipelineVisibility",
    content: pipelineStep(
      {
        kind: "pipeline",
        op: "assert_visibility",
        marker: PIPELINE_MARKER,
        role: "front_desk",
        params: { index: "occupancy", expect_visible: false },
      },
      {
        kind: "pipeline",
        op: "assert_visibility",
        ok: true,
        expected: { visible: false },
        observed: { visible: false },
      },
      { label: "Check the front desk cannot see the fixture", latencyMs: 290 },
    ),
  },
];

const FORWARD_STEPS: StepFixture[] = [
  {
    name: "forwardUnknownKind",
    content: adapterStep(
      "http",
      wirePayload<AnyStepRequest>({
        kind: "grpc",
        target: "gracie.v1.Rooms/List",
        metadata: { authorization: "Bearer ${GRACIE_ADMIN_TOKEN}" },
        message: { property_id: 77, page_size: 20 },
      }),
      wirePayload<AnyStepResponse>({
        kind: "grpc",
        status_code: 0,
        message: { rooms: [{ number: "20003", state: "occupied" }] },
      }),
      { label: "Call the room list over gRPC", latencyMs: 130 },
    ),
  },
  {
    name: "forwardExtraKeys",
    content: webhookStep(
      {
        kind: "webhook",
        url: `${API_BASE}/hooks/ops/guest-requests`,
        headers: { "Content-Type": "application/json" },
        body: WEBHOOK_BODY,
        signature: null,
        delivery_attempt: 2,
        trace_id: "tr_8c1f2e44",
        retry: { max: 3, backoff_ms: 250 },
      },
      {
        kind: "webhook",
        status: 202,
        headers: { "content-type": "application/json" },
        body: { accepted: true },
        outbound_calls: [outboundCall("/notify", 150, { channel: "housekeeping" })],
        region: "eu-west-1",
        server_time: "2026-10-05T09:12:31.204Z",
      },
      { label: "Send a webhook whose payload carries extra fields", latencyMs: 340 },
    ),
  },
  {
    name: "forwardMalformed",
    content: adapterStep(
      "websocket",
      wirePayload<AnyStepRequest>({ kind: "websocket", url: `${WS_BASE}/ws/property-events` }),
      wirePayload<AnyStepResponse>({ kind: "websocket", close_code: 1000 }),
      { label: "Read a WebSocket step missing its message lists", latencyMs: 410 },
    ),
  },
];

registerStepFixtureGroup({
  key: ADAPTER_GROUPS.webhook,
  cell: {
    feature_id: "guest_requests.write.create_service_request",
    role: "front_desk",
    interface_id: "rest_api",
  },
  attempts: [{ outcome: "fail", steps: WEBHOOK_STEPS }],
});

registerStepFixtureGroup({
  key: ADAPTER_GROUPS.websocket,
  cell: { feature_id: "access.read.who_am_i", role: "manager", interface_id: "rest_api" },
  attempts: [{ outcome: "fail", steps: WEBSOCKET_STEPS }],
});

registerStepFixtureGroup({
  key: ADAPTER_GROUPS.graphql,
  cell: {
    feature_id: "reports.read.occupancy_summary",
    role: "manager",
    interface_id: "rest_api",
  },
  attempts: [{ outcome: "fail", steps: GRAPHQL_STEPS }],
});

registerStepFixtureGroup({
  key: ADAPTER_GROUPS.cli,
  cell: { feature_id: "access.admin.manage_roles", role: "manager", interface_id: "rest_api" },
  attempts: [{ outcome: "fail", steps: CLI_STEPS }],
});

registerStepFixtureGroup({
  key: ADAPTER_GROUPS.pipeline,
  cell: { feature_id: "reports.read.occupancy_summary", role: "admin", interface_id: "rest_api" },
  attempts: [{ outcome: "fail", steps: PIPELINE_STEPS }],
});

registerStepFixtureGroup({
  key: ADAPTER_GROUPS.forward,
  cell: { feature_id: "access.admin.manage_roles", role: "admin", interface_id: "rest_api" },
  attempts: [{ outcome: "pass", steps: FORWARD_STEPS }],
});
