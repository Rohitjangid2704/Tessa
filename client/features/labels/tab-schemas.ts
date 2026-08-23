import { createSearchParamsCodec, enumParam, uuidParam } from "@/lib/search-params";

export const LABELS_TABS = ["queue", "calibration", "export"] as const;

export type LabelsTab = (typeof LABELS_TABS)[number];

export const DEFAULT_LABELS_TAB: LabelsTab = "queue";

export const labelsTabCodec = createSearchParamsCodec({ tab: enumParam(LABELS_TABS) });

export const calibrationFitCodec = createSearchParamsCodec({ fit: uuidParam() });

export function readLabelsTab(value: string): LabelsTab | undefined {
  return LABELS_TABS.find((tab) => tab === value);
}
