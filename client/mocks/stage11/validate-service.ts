import type { BundleValidationReport, FixupItem, ProposalCheck } from "@/lib/api/types";
import { buildBundle } from "../factories/bundles";
import { newId } from "../factories/ids";
import { buildBundleContent, type ContentKind } from "../stage1/bundle-content";
import { diffBundles, summarize } from "../stage1/diff";
import { buildFixupItems, schemaUrlFor } from "../stage1/render-prompt";
import type { BundleRecord, StageOneStore, TargetRecord } from "../stage1/store";

export const PROPOSAL_FILE_MARKER = "proposal";

const PROPOSAL_SAMPLE_ITEMS = 8;

export function hasProposalMarker(fileName: string): boolean {
  return fileName.toLowerCase().includes(PROPOSAL_FILE_MARKER);
}

function proposalSummary(): ProposalCheck {
  return { items: PROPOSAL_SAMPLE_ITEMS, warnings: [], errors: [] };
}

function recordOf(kind: ContentKind, target: TargetRecord | null, origin: string): BundleRecord {
  const content = buildBundleContent(
    kind,
    target?.targetToken ?? "tgt_validationonlytoken00",
    schemaUrlFor(origin),
  );
  const bundle = buildBundle({
    id: newId(),
    target_id: target?.id ?? newId(),
    validation_status: content.validationStatus,
    errors: content.errors,
    warnings: content.warnings,
    completeness: content.completeness,
    feature_count: content.features.length,
    file_count: content.files.length,
    size_bytes: content.files.reduce((sum, file) => sum + file.size_bytes, 0),
    hooks_missing: content.hooksMissing,
  });
  return {
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
}

function toWireFixupItems(record: BundleRecord): FixupItem[] {
  return buildFixupItems(record).map((item) => ({
    kind: item.kind,
    location: item.location,
    message: item.message,
    fix_hint: item.fixHint ?? "",
  }));
}

export interface ValidationRequest {
  kind: ContentKind;
  target: TargetRecord | null;
  store: StageOneStore;
  origin: string;
  withProposal: boolean;
}

export function buildValidationReport(request: ValidationRequest): BundleValidationReport {
  const { kind, target, store, origin, withProposal } = request;
  const record = recordOf(kind, target, origin);
  const { bundle } = record;
  const previousValid = target === null ? null : (store.latestValidBundle(target.id) ?? null);
  const diffSummary =
    bundle.validation_status === "valid" && previousValid !== null
      ? {
          against_bundle_id: previousValid.bundle.id,
          against_version: previousValid.bundle.version,
          ...summarize(diffBundles(record, previousValid).features),
        }
      : null;
  return {
    validation_status: bundle.validation_status,
    commit_sha: bundle.commit_sha ?? null,
    branch: bundle.branch ?? null,
    errors: bundle.errors,
    warnings: bundle.warnings,
    completeness: bundle.completeness,
    diff_summary: diffSummary,
    fixup_items: toWireFixupItems(record),
    hooks_missing: bundle.hooks_missing,
    feature_count: bundle.feature_count,
    file_count: bundle.file_count,
    size_bytes: bundle.size_bytes,
    proposal: withProposal && bundle.validation_status === "valid" ? proposalSummary() : null,
  };
}
