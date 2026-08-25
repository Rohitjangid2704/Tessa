import { http } from "msw";
import { z } from "zod";
import { MockApiError } from "../factories/errors";
import { QueryReader } from "../factories/pagination";
import { CONTROL_OPTIONS, parseControlBody } from "../stage10/labels-probes-control";
import {
  buildLabelExport,
  LABEL_EXPORT_CONTENT_TYPE,
  LABEL_EXPORT_FILENAME,
} from "../stage10/labels-export-data";
import {
  applyLabelVolumeSeed,
  buildLabelStats,
  LABEL_EXPORT_DEFAULT_MIN_COUNT,
  LABEL_VOLUME_SEEDS,
  labelVolume,
} from "../stage10/labels-volume";
import { stageFour } from "../stage4/support";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

const EXPORT_FORMATS = ["jsonl"] as const;

const volumeBodySchema = z.strictObject({ seed: z.enum(LABEL_VOLUME_SEEDS) });

function belowMinCount(total: number, minCount: number): MockApiError {
  return new MockApiError(
    409,
    "conflict",
    `Only ${total} human labels exist, ${minCount} are needed before an export`,
    [
      {
        loc: ["query", "min_count"],
        code: "labels_below_min_count",
        message: `${total} of ${minCount} human labels`,
      },
    ],
  );
}

async function exportLabels(context: ApiContext): Promise<Response> {
  await requireUser(context, "admin");
  const query = new QueryReader(context.url.searchParams);
  const minCount = query.integer("min_count", { min: 1 }) ?? LABEL_EXPORT_DEFAULT_MIN_COUNT;
  query.enumList("format", EXPORT_FORMATS);
  query.finish();
  const total = buildLabelStats(stageFour(context).labels).total_human;
  if (total < minCount) {
    throw belowMinCount(total, minCount);
  }
  return new Response(buildLabelExport(total), {
    status: 200,
    headers: {
      "Content-Type": LABEL_EXPORT_CONTENT_TYPE,
      "Content-Disposition": `attachment; filename="${LABEL_EXPORT_FILENAME}"`,
    },
  });
}

function describeVolume(context: ApiContext) {
  const stats = buildLabelStats(stageFour(context).labels);
  return {
    seed: labelVolume.seed,
    extra_human: labelVolume.extraHuman,
    total_human: stats.total_human,
    agreement_with_machine: stats.agreement_with_machine,
    by_subject_type: stats.by_subject_type,
  };
}

async function seedLabelVolume(context: ApiContext): Promise<Response> {
  const { seed } = await parseControlBody(context, volumeBodySchema);
  applyLabelVolumeSeed(seed);
  return jsonResponse(describeVolume(context));
}

function readLabelVolume(context: ApiContext): Response {
  return jsonResponse(describeVolume(context));
}

export const labelsExportHandlers = [
  http.get("*/api/v1/labels/export", api(exportLabels)),
  http.get("*/__mock/stage10/labels", api(readLabelVolume, CONTROL_OPTIONS)),
  http.post("*/__mock/stage10/labels", api(seedLabelVolume, CONTROL_OPTIONS)),
];
