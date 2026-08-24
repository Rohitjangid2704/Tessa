import type { components } from "@/lib/api/schema";

type Schemas = components["schemas"];

export type Target = Schemas["Target"];
export type TargetSummary = Schemas["TargetSummary"];
export type TargetCreate = Schemas["TargetCreate"];
export type TargetUpdate = Schemas["TargetUpdate"];
export type TargetTier = Schemas["TargetTier"];
export type AppKind = Schemas["AppKind"];
export type AppKindList = Schemas["AppKindList"];
export type AppKindOption = Schemas["AppKindOption"];
export type AppKindHint = Schemas["AppKindHint"];
export type HealthCheckStatus = Schemas["HealthCheckStatus"];
