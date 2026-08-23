import {
  enumListParam,
  createSearchParamsCodec,
  stringListParam,
  textParam,
} from "@/lib/search-params";
import type { Confidence, FeatureKind } from "./types";

export const FEATURE_KINDS = [
  "read",
  "write",
  "flow",
  "auth",
  "admin",
  "stream",
  "job",
] as const satisfies readonly FeatureKind[];

export const CONFIDENCES = ["high", "medium", "low"] as const satisfies readonly Confidence[];

export const FEATURE_KIND_LABELS: Record<FeatureKind, string> = {
  read: "Read",
  write: "Write",
  flow: "Flow",
  auth: "Auth",
  admin: "Admin",
  stream: "Stream",
  job: "Job",
};

export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const ALL_ROLES_ID = "all";
export const NO_FLAG = "none";
export const NO_CLEANUP = "none";

export const catalogFiltersCodec = createSearchParamsCodec({
  q: textParam(),
  area: stringListParam(),
  kind: enumListParam(FEATURE_KINDS),
  role: stringListParam(),
  interface_id: stringListParam(),
  confidence: enumListParam(CONFIDENCES),
});

export const catalogFiltersSchema = catalogFiltersCodec.schema;

export type CatalogFilterValues = ReturnType<typeof catalogFiltersCodec.parse>;

export type CatalogFilterKey = keyof CatalogFilterValues;
