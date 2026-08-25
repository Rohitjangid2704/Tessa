import type { CatalogItem } from "../factories/catalog";
import type { BundleRecord } from "../stage1/store";
import type {
  AdapterKind,
  InterfaceMode,
  PlanSelection,
  PlanSkippedItem,
  SkipReason,
} from "@/lib/api/types";

export const SUPPORTED_ADAPTERS: readonly AdapterKind[] = ["http", "sse", "browser"];

const ALL_ROLES = "all";

export interface ExpandedCell {
  key: string;
  featureId: string;
  area: string;
  role: string;
  interfaceId: string;
  interfaceKind: AdapterKind;
  productionBlocked: boolean;
  adapterUnsupported: boolean;
}

export interface Expansion {
  cells: ExpandedCell[];
  skipped: PlanSkippedItem[];
  warnings: string[];
  features: CatalogItem[];
}

function featureSkip(featureId: string, reason: SkipReason): PlanSkippedItem {
  return { feature_id: featureId, role: null, interface_id: null, reason };
}

export interface ExpandOptions {
  productionTier: boolean;
}

export function cellKey(featureId: string, role: string, interfaceId: string): string {
  return `${featureId}|${role}|${interfaceId}`;
}

export function isWriteFeature(item: CatalogItem): boolean {
  return (
    item.kind === "write" ||
    item.kind === "admin" ||
    item.kind === "job" ||
    (item.writes_to !== null && item.writes_to !== undefined) ||
    (item.kind === "flow" && item.cleanup.trim().toLowerCase() !== "none")
  );
}

function modeAccepts(mode: InterfaceMode, kind: AdapterKind): boolean {
  if (mode === "api_only") {
    return kind !== "browser";
  }
  if (mode === "browser_only") {
    return kind === "browser";
  }
  return true;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function expandSelection(
  record: BundleRecord,
  selection: PlanSelection,
  options: ExpandOptions,
): Expansion {
  const { features, roles, interfaces } = record;
  const warnings: string[] = [];
  const knownFeatures = new Set(features.map((feature) => feature.feature_id));
  const knownAreas = new Set(features.map((feature) => feature.area));
  const knownRoles = new Set(roles.map((role) => role.id));
  const version = record.bundle.version;

  const selectedFeatureIds = selection.feature_ids ?? [];
  const selectedAreaIds = selection.area_ids ?? [];
  const selectedRoles = selection.roles ?? [];

  for (const featureId of selectedFeatureIds) {
    if (!knownFeatures.has(featureId)) {
      warnings.push(`Feature ${featureId} is not in bundle v${version} and was ignored`);
    }
  }
  for (const area of selectedAreaIds) {
    if (!knownAreas.has(area)) {
      warnings.push(`Area ${area} is not in bundle v${version} and was ignored`);
    }
  }
  const everyRole = selectedRoles.length === 0 || selectedRoles.includes(ALL_ROLES);
  if (!everyRole) {
    for (const role of selectedRoles) {
      if (!knownRoles.has(role)) {
        warnings.push(`Role ${role} is not in bundle v${version} and was ignored`);
      }
    }
  }

  const wantedFeatures = new Set(selectedFeatureIds);
  const wantedAreas = new Set(selectedAreaIds);
  const selected = features.filter(
    (feature) => wantedFeatures.has(feature.feature_id) || wantedAreas.has(feature.area),
  );
  const interfaceById = new Map(interfaces.map((entry) => [entry.id, entry]));
  const allRoleIds = roles.map((role) => role.id);

  const cells: ExpandedCell[] = [];
  const skipped: PlanSkippedItem[] = [];
  const withoutExamples: string[] = [];

  for (const feature of selected) {
    const featureRoles = (feature.roles.includes(ALL_ROLES) ? allRoleIds : feature.roles).filter(
      (role) => everyRole || selectedRoles.includes(role),
    );
    if (featureRoles.length === 0) {
      skipped.push(featureSkip(feature.feature_id, "role_unavailable"));
      continue;
    }
    const featureInterfaces = feature.interface_ids.flatMap((id) => {
      const entry = interfaceById.get(id);
      return entry !== undefined && modeAccepts(selection.interface_mode, entry.kind)
        ? [entry]
        : [];
    });
    if (featureInterfaces.length === 0) {
      skipped.push(featureSkip(feature.feature_id, "adapter_unsupported"));
      continue;
    }
    if (feature.examples.length === 0) {
      skipped.push(featureSkip(feature.feature_id, "precondition_failed"));
      withoutExamples.push(feature.feature_id);
      continue;
    }
    const writeBlocked = options.productionTier && isWriteFeature(feature);
    if (writeBlocked) {
      skipped.push(featureSkip(feature.feature_id, "production_blocked"));
    }
    for (const role of featureRoles) {
      for (const entry of featureInterfaces) {
        cells.push({
          key: cellKey(feature.feature_id, role, entry.id),
          featureId: feature.feature_id,
          area: feature.area,
          role,
          interfaceId: entry.id,
          interfaceKind: entry.kind,
          productionBlocked: writeBlocked,
          adapterUnsupported: !SUPPORTED_ADAPTERS.includes(entry.kind),
        });
      }
    }
  }

  if (withoutExamples.length > 0) {
    warnings.push(
      `${plural(withoutExamples.length, "feature")} without bundle examples cannot get a smoke scenario: ${withoutExamples.join(", ")}`,
    );
  }
  const blocked = skipped.filter((entry) => entry.reason === "production_blocked").length;
  if (blocked > 0) {
    warnings.push(
      `The target is a production target: the run is read-only and ${plural(blocked, "write feature")} will be skipped`,
    );
  }
  const unsupported = cells.filter((cell) => cell.adapterUnsupported).length;
  if (unsupported > 0) {
    warnings.push(`${plural(unsupported, "cell")} use an interface kind that is not supported yet`);
  }
  if (cells.length === 0 && selected.length === 0) {
    warnings.push("The selection matches no feature of the bundle");
  }

  return { cells, skipped, warnings, features: selected };
}

export function runnableCellCount(cells: readonly ExpandedCell[]): number {
  return cells.filter((cell) => !cell.productionBlocked && !cell.adapterUnsupported).length;
}
