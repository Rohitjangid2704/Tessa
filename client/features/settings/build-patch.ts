import type { SettingsPatch, SettingsRead } from "@/lib/api/types";
import {
  isOverridden,
  leafSpecs,
  parseDecimal,
  parseInteger,
  storedLeaf,
  storedText,
  validateLeaf,
  type LeafSpec,
  type SettingsGroup,
} from "./schemas";

export interface SectionInput {
  values: Readonly<Record<string, string | undefined>>;
  reset: Readonly<Record<string, boolean | undefined>>;
}

export type SettingsFormInput = Partial<Record<SettingsGroup, SectionInput>>;

export type LeafChange =
  | { kind: "set"; spec: LeafSpec; value: string | number }
  | { kind: "reset"; spec: LeafSpec }
  | { kind: "invalid"; spec: LeafSpec };

function numericValue(spec: LeafSpec, typed: string): number | null {
  return spec.kind === "positive-integer" ? parseInteger(typed) : parseDecimal(typed);
}

function changeOf(settings: SettingsRead, spec: LeafSpec, input: SectionInput): LeafChange | null {
  if (input.reset[spec.id] === true) {
    return isOverridden(settings, spec) ? { kind: "reset", spec } : null;
  }
  const typed = (input.values[spec.id] ?? "").trim();
  const stored = storedLeaf(settings, spec);
  if (spec.kind === "optional-url") {
    if (typed === "") {
      return stored === null ? null : { kind: "reset", spec };
    }
    if (validateLeaf(spec.kind, typed) !== null) {
      return { kind: "invalid", spec };
    }
    return typed === stored ? null : { kind: "set", spec, value: typed };
  }
  if (typed === storedText(settings, spec)) {
    return null;
  }
  if (validateLeaf(spec.kind, typed) !== null) {
    return { kind: "invalid", spec };
  }
  if (typeof stored === "number") {
    const parsed = numericValue(spec, typed);
    if (parsed === null) {
      return { kind: "invalid", spec };
    }
    return parsed === stored ? null : { kind: "set", spec, value: parsed };
  }
  return { kind: "set", spec, value: typed };
}

export function collectChanges(
  settings: SettingsRead,
  group: SettingsGroup,
  input: SectionInput,
): LeafChange[] {
  return leafSpecs(group).flatMap((spec) => {
    const change = changeOf(settings, spec, input);
    return change === null ? [] : [change];
  });
}

export function buildSettingsPatch(settings: SettingsRead, form: SettingsFormInput): SettingsPatch {
  const patch: Record<string, Record<string, unknown>> = {};
  for (const [group, input] of Object.entries(form)) {
    if (input === undefined) {
      continue;
    }
    for (const change of collectChanges(settings, group as SettingsGroup, input)) {
      if (change.kind === "invalid") {
        continue;
      }
      const value = change.kind === "reset" ? null : change.value;
      const [first = "", second] = change.spec.path;
      const groupPatch = (patch[change.spec.group] ??= {});
      if (second === undefined) {
        groupPatch[first] = value;
      } else {
        const rolePatch = (groupPatch[first] ??= {}) as Record<string, unknown>;
        rolePatch[second] = value;
      }
    }
  }
  return patch as SettingsPatch;
}

function patchLeafValues(patch: SettingsPatch): unknown[] {
  const values: unknown[] = [];
  for (const group of Object.values(patch)) {
    for (const entry of Object.values(group ?? {})) {
      if (typeof entry === "object" && entry !== null) {
        values.push(...Object.values(entry));
      } else {
        values.push(entry);
      }
    }
  }
  return values;
}

export function countPatchLeaves(patch: SettingsPatch): number {
  return patchLeafValues(patch).length;
}

export function isPatchEmpty(patch: SettingsPatch): boolean {
  return countPatchLeaves(patch) === 0;
}

export function describeSaved(patch: SettingsPatch): string {
  const values = patchLeafValues(patch);
  const resetCount = values.filter((value) => value === null).length;
  const setCount = values.length - resetCount;
  const parts = [
    setCount > 0 ? `${setCount} ${setCount === 1 ? "setting" : "settings"} saved` : null,
    resetCount > 0
      ? `${resetCount} ${resetCount === 1 ? "setting" : "settings"} reset to default`
      : null,
  ].filter((part): part is string => part !== null);
  return `${parts.join(", ")}.`;
}

export function countChangedLeaves(
  settings: SettingsRead,
  group: SettingsGroup,
  input: SectionInput,
): number {
  return collectChanges(settings, group, input).length;
}
