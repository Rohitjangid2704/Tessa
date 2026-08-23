import type { EnvironmentVariable } from "@/features/environment/types";

const CREDENTIAL_KINDS: readonly EnvironmentVariable["kind"][] = ["token", "password"];

export interface CredentialOption {
  name: string;
  label: string;
}

function describeVariable(variable: EnvironmentVariable): string {
  return `${variable.name} (${variable.kind}, ${variable.has_value ? "value set" : "no value yet"})`;
}

export function credentialOptions(
  variables: readonly EnvironmentVariable[],
  selected: string,
): CredentialOption[] {
  const options = variables
    .filter((variable) => CREDENTIAL_KINDS.includes(variable.kind) && !variable.stale)
    .map((variable) => ({ name: variable.name, label: describeVariable(variable) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (selected !== "" && !options.some((option) => option.name === selected)) {
    options.push({ name: selected, label: `${selected} (not a token or password variable now)` });
  }
  return options;
}
