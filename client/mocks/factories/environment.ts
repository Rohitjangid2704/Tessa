import type { components } from "@/lib/api/schema";

type Schemas = components["schemas"];

export type EnvironmentVariable = Schemas["EnvironmentVariable"];
export type EnvironmentList = Schemas["EnvironmentList"];
export type EnvironmentPatch = Schemas["EnvironmentPatch"];
export type HealthState = Schemas["HealthState"];
export type HealthReport = Schemas["HealthReport"];
export type HealthReportInterface = Schemas["HealthReportInterface"];
export type HealthCheckStatus = Schemas["HealthCheckStatus"];

export function buildHealthState(overrides: Partial<HealthState> = {}): HealthState {
  return { status: "unchecked", checked_at: null, latency_ms: null, message: null, ...overrides };
}

export function buildEnvironmentVariable(
  overrides: Partial<EnvironmentVariable> = {},
): EnvironmentVariable {
  return {
    name: "TARGET_API_URL",
    kind: "url",
    secret: true,
    required: true,
    purpose: "Origin of the app under test",
    interface_ids: [],
    has_value: false,
    value: null,
    stale: false,
    last_set_at: null,
    last_set_by: null,
    health: buildHealthState(),
    ...overrides,
  };
}

export function buildEnvironmentList(
  items: readonly EnvironmentVariable[],
  overrides: Partial<Omit<EnvironmentList, "items">> = {},
): EnvironmentList {
  return {
    items: [...items],
    missing_required: items.filter(
      (variable) => variable.required && !variable.stale && !variable.has_value,
    ).length,
    ...overrides,
  };
}

export function buildHealthReportInterface(
  overrides: Partial<HealthReportInterface> = {},
): HealthReportInterface {
  return {
    interface_id: "rest_api",
    kind: "http",
    status: "ok",
    latency_ms: 42,
    message: "HTTP 200",
    variables: [],
    ...overrides,
  };
}

export function buildHealthReport(overrides: Partial<HealthReport> = {}): HealthReport {
  return {
    target_id: "00000000-0000-7000-8000-000000000000",
    checked_at: null,
    interfaces: [],
    ...overrides,
  };
}
