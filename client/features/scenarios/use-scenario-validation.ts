import { useQuery } from "@tanstack/react-query";
import type { ScenarioValidation } from "@/lib/api/types";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { scenarioValidationQuery } from "./queries";

export const VALIDATION_DEBOUNCE_MS = 600;

export type ValidationStatus = "idle" | "checking" | "ready" | "unavailable";

export interface ScenarioValidationState {
  status: ValidationStatus;
  validation: ScenarioValidation | null;
  error: unknown;
}

export interface UseScenarioValidationInput {
  targetId: string;
  yaml: string;
  enabled: boolean;
}

export function useScenarioValidation({
  targetId,
  yaml,
  enabled,
}: UseScenarioValidationInput): ScenarioValidationState {
  const settledYaml = useDebouncedValue(yaml, VALIDATION_DEBOUNCE_MS);
  const unchanged = settledYaml === yaml;
  const active = enabled && settledYaml.trim() !== "";
  const query = useQuery({ ...scenarioValidationQuery(targetId, settledYaml), enabled: active });

  if (!active) {
    return { status: "idle", validation: null, error: null };
  }
  if (!unchanged) {
    return { status: "checking", validation: null, error: null };
  }
  if (query.isError) {
    return { status: "unavailable", validation: null, error: query.error };
  }
  if (query.data === undefined) {
    return { status: "checking", validation: null, error: null };
  }
  return { status: "ready", validation: query.data, error: null };
}
