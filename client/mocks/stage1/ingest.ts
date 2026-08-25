import { buildBundle, buildValidationError, type Bundle } from "../factories/bundles";
import { buildHealthState } from "../factories/environment";
import { newId } from "../factories/ids";
import type { DeclaredVariable } from "../fixtures/gracie-env";
import { buildBundleContent, type ContentKind } from "./bundle-content";
import { diffBundles, summarize } from "./diff";
import { schemaUrlFor } from "./render-prompt";
import type { BundleRecord, EnvironmentEntry, StageOneStore, TargetRecord } from "./store";

const ROTATED_TOKEN_WARNING = buildValidationError({
  code: "target_token_rotated",
  message:
    "manifest.yaml carries the previous target_token; use the current one from the latest Discovery or Fix-up prompt",
  severity: "warning",
  file: "manifest.yaml",
  pointer: "/target_token",
  line: null,
  column: null,
});

const ALWAYS_SECRET_KINDS = new Set(["dsn", "token", "password"]);

export interface IngestInput {
  store: StageOneStore;
  target: TargetRecord;
  kind: ContentKind;
  source: Bundle["source"];
  note: string | null;
  uploadedBy: string;
  origin: string;
  now: string;
  rotatedToken?: boolean;
}

export interface IngestResult {
  record: BundleRecord;
  created: boolean;
}

export function reconcileEnvironment(
  entries: EnvironmentEntry[],
  declared: readonly DeclaredVariable[],
): void {
  const wanted = new Map(declared.map((variable) => [variable.name, variable]));
  for (const entry of entries) {
    const variable = wanted.get(entry.name);
    if (variable === undefined) {
      entry.stale = true;
      continue;
    }
    const declaredSecret = ALWAYS_SECRET_KINDS.has(variable.kind) || variable.secret;
    entry.kind = variable.kind;
    entry.secret = declaredSecret || (entry.secret && entry.value !== null);
    entry.required = variable.required;
    entry.purpose = variable.purpose;
    entry.interface_ids = [...variable.interface_ids];
    entry.stale = false;
  }
  const known = new Set(entries.map((entry) => entry.name));
  for (const variable of declared) {
    if (known.has(variable.name)) {
      continue;
    }
    entries.push({
      name: variable.name,
      kind: variable.kind,
      secret: ALWAYS_SECRET_KINDS.has(variable.kind) || variable.secret,
      required: variable.required,
      purpose: variable.purpose,
      interface_ids: [...variable.interface_ids],
      value: null,
      stale: false,
      last_set_at: null,
      last_set_by: null,
      health: buildHealthState(),
    });
  }
}

export function ingestBundle(input: IngestInput): IngestResult {
  const { store, target, kind, source, note, uploadedBy, origin, now, rotatedToken } = input;
  const content = buildBundleContent(kind, target.targetToken, schemaUrlFor(origin));
  const existing = store.bundlesOf(target.id);
  const identical = existing.find((record) => record.bundle.hash === content.hash);
  if (identical !== undefined) {
    return { record: identical, created: false };
  }
  const version = (existing.at(-1)?.bundle.version ?? 0) + 1;
  const bundle = buildBundle({
    id: newId(),
    target_id: target.id,
    version,
    hash: content.hash,
    source,
    note,
    uploaded_by: uploadedBy,
    uploaded_at: now,
    validation_status: content.validationStatus,
    errors: content.errors,
    warnings: rotatedToken ? [...content.warnings, ROTATED_TOKEN_WARNING] : content.warnings,
    completeness: content.completeness,
    feature_count: content.features.length,
    file_count: content.files.length,
    size_bytes: content.files.reduce((sum, file) => sum + file.size_bytes, 0),
    hooks_missing: content.hooksMissing,
  });
  const record: BundleRecord = {
    bundle,
    features: content.features.map((feature) => ({
      ...feature,
      id: newId(),
      bundle_id: bundle.id,
    })),
    roles: content.roles.map((role) => ({ ...role })),
    interfaces: content.interfaces.map((entry) => ({ ...entry })),
    truthSources: content.truthSources,
    environment: content.environment,
    files: content.files,
    sections: content.sections,
  };
  const previousValid = store.latestValidBundle(target.id) ?? null;
  if (content.validationStatus === "valid" && previousValid !== null) {
    const diff = diffBundles(record, previousValid);
    bundle.diff_summary = {
      against_bundle_id: previousValid.bundle.id,
      against_version: previousValid.bundle.version,
      ...summarize(diff.features),
    };
  }
  store.bundles.push(record);
  if (content.validationStatus === "valid") {
    reconcileEnvironment(store.environmentOf(target.id), content.environment);
  }
  return { record, created: true };
}
