import { parseDocument } from "yaml";

export const SCENARIO_SKELETON_YAML = `schema_version: 1
title: Staff lists open maintenance issues
feature_id: smart_log.read.open_maintenance
family: smart-log
role: manager
interface_id: rest_api
timeout_seconds: 120
steps:
  - adapter: http
    label: List open issues
    request:
      method: GET
      path: /guest-requests
    expect:
      status: 200
`;

export const SCENARIO_REQUIRED_KEYS = [
  "schema_version",
  "title",
  "family",
  "role",
  "interface_id",
  "steps",
] as const;

export interface SkeletonCheck {
  parsable: boolean;
  syntaxMessage: string | null;
  missingKeys: string[];
}

export function checkScenarioSkeleton(yamlText: string): SkeletonCheck {
  const document = parseDocument(yamlText);
  const syntaxError = document.errors[0];
  if (syntaxError !== undefined) {
    return {
      parsable: false,
      syntaxMessage: syntaxError.message.split("\n")[0] ?? syntaxError.message,
      missingKeys: [],
    };
  }
  const parsed: unknown = document.toJS();
  const present =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? new Set(Object.keys(parsed))
      : new Set<string>();
  return {
    parsable: true,
    syntaxMessage: null,
    missingKeys: SCENARIO_REQUIRED_KEYS.filter((key) => !present.has(key)),
  };
}
