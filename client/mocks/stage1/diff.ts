import type { BundleDiff } from "../factories/bundles";
import type { BundleRecord } from "./store";

export interface DiffCounts {
  features_added: number;
  features_removed: number;
  features_changed: number;
}

export const NO_BASE_SUMMARY = "There is no earlier valid version to compare with.";

const COMPARED_FIELDS = [
  "area",
  "cleanup",
  "confidence",
  "confirmation",
  "description",
  "examples",
  "expect_db",
  "flag",
  "interface_ids",
  "invariants",
  "kind",
  "preconditions",
  "roles",
  "writes_to",
] as const;

const IDENTITY_SECTIONS = new Set(["schema", "target_token"]);
const MANIFEST_FILE = "manifest.yaml";
const FILES_SECTION_PREFIX = "files:";

type FeatureView = Record<string, unknown>;

function featureView(record: BundleRecord, featureId: string): FeatureView | null {
  const feature = record.features.find((candidate) => candidate.feature_id === featureId);
  if (feature === undefined) {
    return null;
  }
  return Object.fromEntries(COMPARED_FIELDS.map((field) => [field, feature[field]]));
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function sectionHashes(record: BundleRecord): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const [name, value] of Object.entries(record.sections)) {
    if (!IDENTITY_SECTIONS.has(name)) {
      hashes.set(name, JSON.stringify(value));
    }
  }
  const groups = new Map<string, Array<[string, string]>>();
  for (const file of record.files) {
    if (file.path !== MANIFEST_FILE) {
      const group = file.path.split("/")[0] ?? file.path;
      groups.set(group, [...(groups.get(group) ?? []), [file.path, file.sha256]]);
    }
  }
  for (const [group, pairs] of groups) {
    hashes.set(`${FILES_SECTION_PREFIX}${group}`, JSON.stringify(pairs.sort()));
  }
  return hashes;
}

export function summarize(features: BundleDiff["features"]): DiffCounts {
  const count = (change: "added" | "removed" | "changed") =>
    features.filter((entry) => entry.change === change).length;
  return {
    features_added: count("added"),
    features_removed: count("removed"),
    features_changed: count("changed"),
  };
}

function plural(count: number, noun: string): string {
  return count === 1 ? `${count} ${noun}` : `${count} ${noun}s`;
}

export function describeDiff(
  features: BundleDiff["features"],
  sections: BundleDiff["sections"],
  againstVersion: number,
): string {
  const base = `version ${againstVersion}`;
  if (features.length === 0 && sections.length === 0) {
    return `No differences from ${base}.`;
  }
  const counts = summarize(features);
  const parts = [
    `${plural(counts.features_added, "feature")} added`,
    `${plural(counts.features_removed, "feature")} removed`,
    `${plural(counts.features_changed, "feature")} changed`,
  ];
  const listing = sections.map((entry) => `${entry.section} ${entry.change}`).join(", ");
  return `Compared with ${base}: ${parts.join(", ")}.${sections.length > 0 ? ` Sections: ${listing}.` : ""}`;
}

export function diffBundles(record: BundleRecord, against: BundleRecord | null): BundleDiff {
  if (against === null) {
    return {
      bundle_id: record.bundle.id,
      against_bundle_id: null,
      features: [],
      sections: [],
      summary: NO_BASE_SUMMARY,
    };
  }
  const ids = [
    ...new Set([
      ...against.features.map((feature) => feature.feature_id),
      ...record.features.map((feature) => feature.feature_id),
    ]),
  ].sort();
  const features: BundleDiff["features"] = [];
  for (const featureId of ids) {
    const before = featureView(against, featureId);
    const after = featureView(record, featureId);
    if (before === null && after !== null) {
      features.push({ feature_id: featureId, change: "added", fields_changed: [], after });
    } else if (before !== null && after === null) {
      features.push({ feature_id: featureId, change: "removed", fields_changed: [], before });
    } else if (before !== null && after !== null) {
      const fieldsChanged = COMPARED_FIELDS.filter(
        (field) => !sameValue(before[field], after[field]),
      );
      if (fieldsChanged.length > 0) {
        features.push({
          feature_id: featureId,
          change: "changed",
          fields_changed: [...fieldsChanged],
          before,
          after,
        });
      }
    }
  }
  const current = sectionHashes(record);
  const base = sectionHashes(against);
  const sections: BundleDiff["sections"] = [...new Set([...current.keys(), ...base.keys()])]
    .sort()
    .flatMap((section) => {
      const before = base.get(section);
      const after = current.get(section);
      if (before === after) {
        return [];
      }
      const change = before === undefined ? "added" : after === undefined ? "removed" : "changed";
      return [{ section, change }];
    });
  return {
    bundle_id: record.bundle.id,
    against_bundle_id: against.bundle.id,
    features,
    sections,
    summary: describeDiff(features, sections, against.bundle.version),
  };
}
