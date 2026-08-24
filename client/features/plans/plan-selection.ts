import { ALL_ROLES_ID } from "@/features/catalog/schemas";
import type { AreaSelectionState } from "@/features/catalog/selection";
import type { Catalog, CatalogInterface } from "@/features/catalog/types";
import { budgetToInput } from "./budget-input";
import { clampAttempts } from "./schemas";
import type { PlanBuilderState } from "./selection-reducer";
import type { Budget, InterfaceMode, Plan, PlanCreateExtended, PlanSelection } from "./types";

export const ALL_ROLES = ALL_ROLES_ID;

export const INTERFACE_MODE_LABELS: Record<InterfaceMode, string> = {
  api_only: "API only",
  browser_only: "Browser only",
  both: "API and browser",
};

export function catalogFeatureIds(catalog: Catalog): Set<string> {
  return new Set(catalog.areas.flatMap((area) => area.items.map((item) => item.feature_id)));
}

export function featureIdByItemId(catalog: Catalog): Map<string, string> {
  return new Map(
    catalog.areas.flatMap((area) =>
      area.items.map((item): [string, string] => [item.id, item.feature_id]),
    ),
  );
}

export function selectedFeatureCount(
  selected: ReadonlySet<string>,
  catalog: Catalog | undefined,
): number {
  if (catalog === undefined) {
    return 0;
  }
  let count = 0;
  for (const featureId of catalogFeatureIds(catalog)) {
    if (selected.has(featureId)) {
      count += 1;
    }
  }
  return count;
}

export function areaFeatureState(
  areaFeatureIds: readonly string[],
  selected: ReadonlySet<string>,
): AreaSelectionState {
  const count = areaFeatureIds.filter((featureId) => selected.has(featureId)).length;
  if (count === 0) {
    return "none";
  }
  return count === areaFeatureIds.length ? "all" : "some";
}

export function normalizeRoleIds(
  roleIds: readonly string[],
  catalogRoleIds: readonly string[],
): string[] {
  const known = catalogRoleIds.filter((roleId) => roleIds.includes(roleId));
  return known.length === catalogRoleIds.length ? [] : known;
}

export function isRoleChecked(roleIds: readonly string[], roleId: string): boolean {
  return roleIds.length === 0 || roleIds.includes(roleId);
}

export function toggleRoleId(
  current: readonly string[],
  roleId: string,
  selected: boolean,
  catalogRoleIds: readonly string[],
): string[] {
  const base = current.length === 0 ? catalogRoleIds : current;
  const next = selected ? [...base, roleId] : base.filter((candidate) => candidate !== roleId);
  if (next.length === 0) {
    return [...current];
  }
  return normalizeRoleIds(next, catalogRoleIds);
}

export interface InterfaceCapabilities {
  hasApi: boolean;
  hasBrowser: boolean;
}

export interface InterfaceModeAvailability {
  enabled: boolean;
  reason: string | null;
}

export function interfaceCapabilities(
  interfaces: readonly Pick<CatalogInterface, "kind">[],
): InterfaceCapabilities {
  return {
    hasApi: interfaces.some((entry) => entry.kind !== "browser"),
    hasBrowser: interfaces.some((entry) => entry.kind === "browser"),
  };
}

export function interfaceModeAvailability(
  mode: InterfaceMode,
  capabilities: InterfaceCapabilities,
): InterfaceModeAvailability {
  const { hasApi, hasBrowser } = capabilities;
  if (mode === "api_only") {
    return hasApi
      ? { enabled: true, reason: null }
      : { enabled: false, reason: "This bundle has no interface other than the browser." };
  }
  if (mode === "browser_only") {
    return hasBrowser
      ? { enabled: true, reason: null }
      : { enabled: false, reason: "This bundle has no browser interface." };
  }
  if (hasApi && hasBrowser) {
    return { enabled: true, reason: null };
  }
  return {
    enabled: false,
    reason: hasBrowser
      ? "This bundle has only a browser interface, so Browser only already covers it."
      : "This bundle has no browser interface, so API only already covers everything.",
  };
}

export function defaultInterfaceMode(capabilities: InterfaceCapabilities): InterfaceMode {
  if (capabilities.hasApi && !capabilities.hasBrowser) {
    return "api_only";
  }
  if (capabilities.hasBrowser && !capabilities.hasApi) {
    return "browser_only";
  }
  return "both";
}

export function resolveInterfaceMode(
  chosen: InterfaceMode | null,
  capabilities: InterfaceCapabilities,
): InterfaceMode {
  if (chosen !== null && interfaceModeAvailability(chosen, capabilities).enabled) {
    return chosen;
  }
  return defaultInterfaceMode(capabilities);
}

export function buildPlanSelection(
  state: PlanBuilderState,
  catalog: Catalog,
  budget: Budget | undefined,
): PlanSelection {
  const areaIds: string[] = [];
  const featureIds: string[] = [];
  for (const area of catalog.areas) {
    const areaFeatureIds = area.items.map((item) => item.feature_id);
    const areaState = areaFeatureState(areaFeatureIds, state.featureIds);
    if (areaState === "all") {
      areaIds.push(area.name);
    } else if (areaState === "some") {
      featureIds.push(...areaFeatureIds.filter((featureId) => state.featureIds.has(featureId)));
    }
  }
  const roleIds = normalizeRoleIds(state.roleIds, catalog.roles.map((role) => role.id));
  const capabilities = interfaceCapabilities(catalog.interfaces);
  const selection: PlanSelection = {
    feature_ids: featureIds,
    area_ids: areaIds,
    roles: roleIds.length === 0 ? [ALL_ROLES] : roleIds,
    interface_mode: resolveInterfaceMode(state.interfaceMode, capabilities),
    depth: state.depth,
    k: clampAttempts(state.k),
  };
  return budget === undefined ? selection : { ...selection, budget };
}

export interface BuildPlanInput {
  targetId: string;
  catalog: Catalog;
  state: PlanBuilderState;
  budget: Budget | undefined;
  saved: boolean;
  name?: string;
}

export function buildPlanCreate({
  targetId,
  catalog,
  state,
  budget,
  saved,
  name,
}: BuildPlanInput): PlanCreateExtended {
  const plan: PlanCreateExtended = {
    target_id: targetId,
    bundle_id: catalog.bundle_id,
    saved,
    selection: buildPlanSelection(state, catalog, budget),
  };
  const withFuzz = state.includeApiFuzz ? { ...plan, include_api_fuzz: true } : plan;
  return name === undefined ? withFuzz : { ...withFuzz, name };
}

function listIds(ids: readonly string[]): string {
  const shown = ids.slice(0, 5).join(", ");
  return ids.length > 5 ? `${shown} and ${ids.length - 5} more` : shown;
}

function omissionNotice(noun: string, ids: readonly string[], version: string): string {
  const plural = ids.length !== 1;
  const subject = `${ids.length} ${noun}${plural ? "s" : ""} of this plan`;
  const verb = plural ? "are" : "is";
  const outcome = plural ? "were" : "was";
  return `${subject} ${verb} not in bundle version${version} and ${outcome} left out: ${listIds(ids)}.`;
}

function partitionRoles(
  wanted: readonly string[],
  catalogRoleIds: readonly string[],
): { known: string[]; unknown: string[] } {
  return {
    known: wanted.filter((roleId) => catalogRoleIds.includes(roleId)),
    unknown: wanted.filter((roleId) => !catalogRoleIds.includes(roleId)),
  };
}

export interface HydratedPlan {
  state: PlanBuilderState;
  notices: string[];
}

export function hydrateBuilderState(
  plan: Plan,
  catalog: Catalog,
  current: PlanBuilderState,
): HydratedPlan {
  const { selection } = plan;
  const wantedFeatures = new Set(selection.feature_ids ?? []);
  const wantedAreas = new Set(selection.area_ids ?? []);
  const knownFeatures = new Set<string>();
  const knownAreas = new Set<string>();
  const featureIds = new Set<string>();
  for (const area of catalog.areas) {
    knownAreas.add(area.name);
    for (const item of area.items) {
      knownFeatures.add(item.feature_id);
      if (wantedFeatures.has(item.feature_id) || wantedAreas.has(area.name)) {
        featureIds.add(item.feature_id);
      }
    }
  }

  const notices: string[] = [];
  const version = catalog.bundle_version === null ? "" : ` ${catalog.bundle_version}`;
  const missingFeatures = [...wantedFeatures].filter((featureId) => !knownFeatures.has(featureId));
  if (missingFeatures.length > 0) {
    notices.push(omissionNotice("feature", missingFeatures, version));
  }
  const missingAreas = [...wantedAreas].filter((name) => !knownAreas.has(name));
  if (missingAreas.length > 0) {
    notices.push(omissionNotice("area", missingAreas, version));
  }

  const catalogRoleIds = catalog.roles.map((role) => role.id);
  const wantedRoles = selection.roles ?? [];
  const everyRole = wantedRoles.length === 0 || wantedRoles.includes(ALL_ROLES);
  const roles = everyRole
    ? { known: [], unknown: [] }
    : partitionRoles(wantedRoles, catalogRoleIds);
  if (roles.unknown.length > 0) {
    notices.push(
      roles.known.length === 0
        ? `None of the roles of this plan exist in bundle version${version}, so every role is selected.`
        : omissionNotice("role", roles.unknown, version),
    );
  }

  const capabilities = interfaceCapabilities(catalog.interfaces);
  const interfaceMode = resolveInterfaceMode(selection.interface_mode, capabilities);
  if (interfaceMode !== selection.interface_mode) {
    const wanted = INTERFACE_MODE_LABELS[selection.interface_mode];
    const used = INTERFACE_MODE_LABELS[interfaceMode];
    notices.push(`The plan used ${wanted}, which this bundle cannot offer, so ${used} is selected.`);
  }

  const budget = budgetToInput(selection.budget);
  return {
    state: {
      ...current,
      featureIds,
      roleIds: normalizeRoleIds(roles.known, catalogRoleIds),
      interfaceMode,
      depth: selection.depth,
      k: clampAttempts(selection.k),
      maxUsd: budget.maxUsd,
      maxMinutes: budget.maxMinutes,
      includeApiFuzz: "include_api_fuzz" in plan && plan.include_api_fuzz === true,
      loadedPlan: { id: plan.id, name: plan.name },
      notices,
    },
    notices,
  };
}

function countNoun(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

export function describePlanSelection(selection: PlanSelection): string {
  const featureCount = selection.feature_ids?.length ?? 0;
  const areaCount = selection.area_ids?.length ?? 0;
  const parts: string[] = [];
  if (areaCount > 0) {
    parts.push(countNoun(areaCount, "area"));
  }
  if (featureCount > 0) {
    parts.push(countNoun(featureCount, "feature"));
  }
  const roles = selection.roles ?? [];
  const everyRole = roles.length === 0 || roles.includes(ALL_ROLES);
  parts.push(everyRole ? "all roles" : `roles ${roles.join(", ")}`);
  parts.push(INTERFACE_MODE_LABELS[selection.interface_mode]);
  parts.push(`${selection.depth} depth`);
  parts.push(`k ${selection.k}`);
  return parts.join(", ");
}
