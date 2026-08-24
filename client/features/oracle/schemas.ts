import { z } from "zod";
import { createSearchParamsCodec, enumListParam, textParam } from "@/lib/search-params";
import type { OracleApproval, OracleLanguage, OracleResultStatus } from "./types";

export const ORACLE_APPROVALS = [
  "unreviewed",
  "approved",
  "rejected",
] as const satisfies readonly OracleApproval[];

export const APPROVAL_LABELS: Record<OracleApproval, string> = {
  unreviewed: "Unreviewed",
  approved: "Approved",
  rejected: "Rejected",
};

export const LANGUAGE_LABELS: Record<OracleLanguage, string> = {
  sql: "SQL",
  python: "Python",
};

export const RESULT_STATUS_LABELS: Record<OracleResultStatus, string> = {
  pending: "Running",
  ok: "OK",
  error: "Error",
};

export const TEMPLATE_ID_PARAM = "template_id";
export const RESULT_ID_PARAM = "result_id";
export const GUID_LENGTH = 36;

export const oracleFiltersCodec = createSearchParamsCodec({
  feature_id: textParam(),
  approval: enumListParam(ORACLE_APPROVALS),
});

export type OracleFilterValues = ReturnType<typeof oracleFiltersCodec.parse>;

export const oracleSelectionCodec = createSearchParamsCodec({
  template_id: textParam(GUID_LENGTH),
  result_id: textParam(GUID_LENGTH),
});

const idSchema = z.guid();

export function readId(value: string | undefined): string | null {
  const parsed = idSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
