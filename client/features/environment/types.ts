import type { components } from "@/lib/api/schema";

type Schemas = components["schemas"];

export type AdapterKind = Schemas["AdapterKind"];
export type EnvironmentVariable = Schemas["EnvironmentVariable"];
export type EnvironmentList = Schemas["EnvironmentList"];
export type EnvironmentPatch = Schemas["EnvironmentPatch"];
export type EnvVarKind = Schemas["EnvVarKind"];
export type HealthReport = Schemas["HealthReport"];
export type HealthReportInterface = Schemas["HealthReportInterface"];
export type HealthState = Schemas["HealthState"];
export type HealthCheckStatus = Schemas["HealthCheckStatus"];
