import { z } from "zod";
import { unwrap, unwrapOptional } from "../client";
import { cutList } from "../cut";
import { localError } from "../errors";
import type { Schemas } from "../types";
import { zipBundleFolder, type ZippedBundle } from "../zip";
import { defineTool, type ToolContext } from "./define";

const PROBLEM_LIST_LIMIT = 100;
const DIFF_LIST_LIMIT = 50;

function bundleForm(zipped: ZippedBundle, targetId: string | undefined, note?: string) {
  const form = new FormData();
  form.append("file", new Blob([zipped.bytes], { type: "application/zip" }), "tessa.zip");
  if (targetId !== undefined) {
    form.append("target_id", targetId);
  }
  if (note !== undefined && note.length > 0) {
    form.append("note", note);
  }
  return form;
}

function resolveTargetId(context: ToolContext, requested: string | undefined, zipped: ZippedBundle) {
  const targetId = requested ?? context.session.state.targetId;
  const knownToken = context.session.state.targetToken;
  if (
    targetId !== undefined &&
    targetId === context.session.state.targetId &&
    knownToken !== undefined &&
    zipped.targetToken !== null &&
    zipped.targetToken !== knownToken
  ) {
    throw localError(
      "target_mismatch",
      "The target_token in tessa/manifest.yaml is not the token of the selected target",
    );
  }
  return targetId;
}

function describeZip(zipped: ZippedBundle) {
  return {
    folder: zipped.folder,
    file_count: zipped.fileCount,
    uncompressed_bytes: zipped.uncompressedBytes,
    excluded: zipped.excluded,
    manifest_has_target_token: zipped.targetToken !== null,
  };
}

function sourceOf(bundle: Schemas["Bundle"]) {
  return { commit_sha: bundle.commit_sha ?? null, branch: bundle.branch ?? null };
}

function problems(items: Schemas["BundleValidationError"][]) {
  const cut = cutList(items, PROBLEM_LIST_LIMIT);
  return { items: cut.items, total: cut.total, truncated: cut.truncated };
}

const pathInput = z
  .string()
  .min(1)
  .describe("Repository folder that contains tessa/, or the tessa folder itself");

export const validateBundle = defineTool({
  name: "validate_bundle",
  title: "Validate bundle",
  description:
    "Read (nothing is stored). Zips the tessa/ folder in memory and asks Tessa to validate, score and diff it. Returns fixup_items first, then errors, warnings, completeness and the diff against the latest stored version. Fix every item and call again before upload_bundle.",
  access: "read",
  idempotent: true,
  input: {
    path: pathInput,
    target_id: z.string().uuid().optional().describe("Defaults to the target selected with get_target"),
  },
  async handler(context, args) {
    const zipped = await zipBundleFolder(args.path);
    const targetId = resolveTargetId(context, args.target_id, zipped);
    const report = await unwrap(
      context.api.client.POST("/api/v1/bundles/validate", {
        body: { file: "", target_id: targetId ?? null },
        bodySerializer: () => bundleForm(zipped, targetId),
      }),
    );
    return {
      validation_status: report.validation_status,
      fixup_items: report.fixup_items,
      errors: problems(report.errors),
      warnings: problems(report.warnings),
      completeness: report.completeness,
      diff_summary: report.diff_summary,
      hooks_missing: report.hooks_missing,
      proposal: report.proposal,
      feature_count: report.feature_count,
      file_count: report.file_count,
      size_bytes: report.size_bytes,
      zip: describeZip(zipped),
    };
  },
});

export const uploadBundle = defineTool({
  name: "upload_bundle",
  title: "Upload bundle",
  description:
    "Write. Zips the tessa/ folder in memory and stores it as a new bundle version of the target. Intake validates it again; authored scenarios are dry-run in a generate run whose id is returned as dry_run_run_id. Only upload after validate_bundle came back valid.",
  access: "write",
  idempotent: false,
  input: {
    path: pathInput,
    note: z.string().max(500).optional().describe("Short note stored with the version"),
    target_id: z.string().uuid().optional().describe("Defaults to the target selected with get_target"),
  },
  async handler(context, args) {
    const zipped = await zipBundleFolder(args.path);
    const targetId = resolveTargetId(context, args.target_id, zipped);
    const result = await unwrap(
      context.api.client.POST("/api/v1/bundles", {
        params: { header: { "Idempotency-Key": context.generateId() } },
        body: { file: "", target_id: targetId ?? null, note: args.note ?? null },
        bodySerializer: () => bundleForm(zipped, targetId, args.note),
      }),
    );
    const bundle = result.bundle;
    return {
      bundle: {
        id: bundle.id,
        target_id: bundle.target_id,
        version: bundle.version,
        validation_status: bundle.validation_status,
        hash: bundle.hash,
        ...sourceOf(bundle),
        feature_count: bundle.feature_count,
        file_count: bundle.file_count,
        size_bytes: bundle.size_bytes,
        scenarios_imported: bundle.scenarios_imported,
        mutants_imported: bundle.mutants_imported,
        completeness: { score: bundle.completeness.score, status: bundle.completeness.status },
        errors: problems(bundle.errors),
        warnings: problems(bundle.warnings),
        hooks_missing: bundle.hooks_missing,
        diff_summary: bundle.diff_summary,
      },
      created: result.created,
      dry_run_run_id: result.dry_run_run_id,
      zip: describeZip(zipped),
    };
  },
});

export const getBundle = defineTool({
  name: "get_bundle",
  title: "Get bundle",
  description:
    "Read. A stored bundle version with its validation status, completeness and the diff against the previous version or against another bundle id.",
  access: "read",
  input: {
    bundle_id: z.string().uuid(),
    against: z.string().uuid().optional().describe("Bundle id to compare with; default is the previous version"),
  },
  async handler(context, args) {
    const [bundle, diff] = await Promise.all([
      unwrap(
        context.api.client.GET("/api/v1/bundles/{bundle_id}", {
          params: { path: { bundle_id: args.bundle_id } },
        }),
      ),
      unwrapOptional(
        context.api.client.GET("/api/v1/bundles/{bundle_id}/diff", {
          params: { path: { bundle_id: args.bundle_id }, query: { against: args.against } },
        }),
      ),
    ]);
    const features = cutList(diff?.features ?? [], DIFF_LIST_LIMIT);
    return {
      bundle: {
        id: bundle.id,
        target_id: bundle.target_id,
        version: bundle.version,
        validation_status: bundle.validation_status,
        hash: bundle.hash,
        source: bundle.source,
        ...sourceOf(bundle),
        uploaded_at: bundle.uploaded_at,
        note: bundle.note ?? null,
        feature_count: bundle.feature_count,
        file_count: bundle.file_count,
        size_bytes: bundle.size_bytes,
        scenarios_imported: bundle.scenarios_imported,
        mutants_imported: bundle.mutants_imported,
        completeness: bundle.completeness,
        errors: problems(bundle.errors),
        warnings: problems(bundle.warnings),
        hooks_missing: bundle.hooks_missing,
        diff_summary: bundle.diff_summary,
      },
      diff: diff
        ? {
            summary: diff.summary,
            against_bundle_id: diff.against_bundle_id,
            sections: diff.sections,
            features: features.items,
            features_total: features.total,
            features_truncated: features.truncated,
          }
        : null,
    };
  },
});
