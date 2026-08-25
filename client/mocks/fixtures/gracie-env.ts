import type { components } from "@/lib/api/schema";

type Schemas = components["schemas"];

export interface DeclaredVariable {
  name: string;
  kind: Schemas["EnvVarKind"];
  secret: boolean;
  required: boolean;
  purpose: string;
  interface_ids: readonly string[];
}

export const GRACIE_ENVIRONMENT: readonly DeclaredVariable[] = [
  {
    name: "GRACIE_API_URL",
    kind: "url",
    secret: false,
    required: true,
    purpose: "Origin of the Gracie REST and chat API in the QA environment",
    interface_ids: ["rest_api", "chat_sse"],
  },
  {
    name: "GRACIE_WEB_URL",
    kind: "url",
    secret: false,
    required: true,
    purpose: "Origin of the Gracie web app that the browser flows open",
    interface_ids: ["browser"],
  },
  {
    name: "GRACIE_EVENTS_URL",
    kind: "url",
    secret: false,
    required: true,
    purpose: "Origin of the property events stream",
    interface_ids: ["events_sse"],
  },
  {
    name: "GRACIE_OPS_HOOK_URL",
    kind: "url",
    secret: false,
    required: false,
    purpose: "Webhook that receives operations notifications; leave empty to skip webhook checks",
    interface_ids: ["ops_webhook"],
  },
  {
    name: "GRACIE_ADMIN_TOKEN",
    kind: "token",
    secret: true,
    required: true,
    purpose: "Bearer token of the QA admin account",
    interface_ids: ["rest_api"],
  },
  {
    name: "GRACIE_GUEST_EMAIL",
    kind: "string",
    secret: false,
    required: true,
    purpose: "Login email of the seeded guest account",
    interface_ids: ["browser", "rest_api"],
  },
  {
    name: "GRACIE_GUEST_PASSWORD",
    kind: "password",
    secret: true,
    required: true,
    purpose: "Password of the seeded guest account",
    interface_ids: ["browser", "rest_api"],
  },
  {
    name: "GRACIE_READONLY_DSN",
    kind: "dsn",
    secret: true,
    required: true,
    purpose: "Read-only Postgres connection that the oracle queries run against",
    interface_ids: [],
  },
  {
    name: "GRACIE_CHAT_TIMEOUT_SECONDS",
    kind: "number",
    secret: false,
    required: false,
    purpose: "How long a chat reply may take before the step times out",
    interface_ids: ["chat_sse"],
  },
  {
    name: "GRACIE_STRICT_CONFIRMATION",
    kind: "bool",
    secret: false,
    required: false,
    purpose: "Whether the assistant must refuse typed confirmations",
    interface_ids: ["chat_sse"],
  },
];

export const GRACIE_ENVIRONMENT_BELOW_BAR: readonly DeclaredVariable[] = [
  ...GRACIE_ENVIRONMENT.filter((variable) =>
    ["GRACIE_API_URL", "GRACIE_WEB_URL", "GRACIE_ADMIN_TOKEN", "GRACIE_GUEST_EMAIL"].includes(
      variable.name,
    ),
  ),
  {
    name: "GRACIE_LEGACY_API_KEY",
    kind: "token",
    secret: true,
    required: true,
    purpose: "Key of the retired v0 API; removed from later bundles",
    interface_ids: ["rest_api"],
  },
  {
    name: "GRACIE_STAGING_URL",
    kind: "url",
    secret: false,
    required: false,
    purpose: "Old staging origin; removed from later bundles",
    interface_ids: ["browser"],
  },
];

export const GRACIE_SEEDED_VALUES: Readonly<Record<string, string>> = {
  GRACIE_API_URL: "https://gracie-api.qa.example.test",
  GRACIE_WEB_URL: "https://gracie-web.qa.example.test",
  GRACIE_EVENTS_URL: "http://gracie-events.down.example.test:9000",
  GRACIE_ADMIN_TOKEN: "dev-only-seeded-admin-token",
  GRACIE_GUEST_EMAIL: "guest.qa@example.test",
  GRACIE_GUEST_PASSWORD: "dev-only-seeded-guest-password",
  GRACIE_LEGACY_API_KEY: "dev-only-seeded-legacy-key",
};

export const UNREACHABLE_HOST_MARKERS: readonly string[] = ["down", "refused", "unreachable"];

export const SEEDED_VARIABLE_SET_AT = "2026-09-29T08:30:00.000Z";
export const SEEDED_HEALTH_CHECKED_AT = "2026-09-29T08:45:00.000Z";
