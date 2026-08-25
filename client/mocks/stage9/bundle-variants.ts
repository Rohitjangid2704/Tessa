import { buildBundle, type Bundle } from "../factories/bundles";
import { ADMIN_USER } from "../factories/users";
import { diffBundles, summarize } from "../stage1/diff";
import type { BundleRecord, StageOneStore, TargetRecord } from "../stage1/store";
import { stableHex, stableId } from "../stage2/ids";

export interface BundleVariantSpec {
  base: BundleRecord;
  source: Bundle["source"];
  note: string | null;
  uploadedAt: string;
  revisionLabel: string | null;
  uploadedBy?: string;
}

function reviseFeatures(
  base: BundleRecord,
  bundleId: string,
  revisionLabel: string | null,
): BundleRecord["features"] {
  return base.features.map((feature, index) => ({
    ...feature,
    id: stableId("library_feature", bundleId, feature.feature_id),
    bundle_id: bundleId,
    description:
      index === 0 && revisionLabel !== null
        ? `${feature.description} (${revisionLabel})`
        : feature.description,
  }));
}

export function appendBundleVariant(
  store: StageOneStore,
  target: TargetRecord,
  spec: BundleVariantSpec,
): BundleRecord {
  const version = (store.latestBundle(target.id)?.bundle.version ?? 0) + 1;
  const id = stableId("library_bundle", target.id, version);
  const bundle = buildBundle({
    ...spec.base.bundle,
    id,
    target_id: target.id,
    version,
    hash: stableHex(64, "library_bundle", target.id, version),
    source: spec.source,
    note: spec.note,
    uploaded_by: spec.uploadedBy ?? ADMIN_USER.id,
    uploaded_at: spec.uploadedAt,
    diff_summary: null,
  });
  const record: BundleRecord = {
    ...spec.base,
    bundle,
    features: reviseFeatures(spec.base, id, spec.revisionLabel),
  };
  const previousValid = store.latestValidBundle(target.id) ?? null;
  if (bundle.validation_status === "valid" && previousValid !== null) {
    bundle.diff_summary = {
      against_bundle_id: previousValid.bundle.id,
      against_version: previousValid.bundle.version,
      ...summarize(diffBundles(record, previousValid).features),
    };
  }
  store.bundles.push(record);
  return record;
}
