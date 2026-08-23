import { useMutation, useQueryClient } from "@tanstack/react-query";
import { downloadAuthedFile } from "@/lib/api/download";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { countJsonlLines, LABEL_EXPORT_MIN_COUNT } from "./export-model";
import { labelStatsQuery } from "./queries";

export const LABELS_EXPORT_ACCEPT = "application/x-ndjson";

export const LABELS_EXPORT_FALLBACK_FILENAME = "tessa-labels-export.jsonl";

export interface LabelsExportResult {
  filename: string;
  lines: number;
}

export function labelExportStatsQuery() {
  return { ...labelStatsQuery(), meta: INLINE_ERROR_META };
}

export function labelsExportPath(minCount: number = LABEL_EXPORT_MIN_COUNT): string {
  return `/api/v1/labels/export?min_count=${minCount}&format=jsonl`;
}

export function useDownloadLabelsExport() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: async (): Promise<LabelsExportResult> => {
      const file = await downloadAuthedFile(labelsExportPath(), {
        accept: LABELS_EXPORT_ACCEPT,
        fallbackFilename: LABELS_EXPORT_FALLBACK_FILENAME,
      });
      return { filename: file.filename, lines: countJsonlLines(await file.blob.text()) };
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: qk.labels.stats() });
    },
  });
}
