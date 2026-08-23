import { readLocationSearchParams, writeLocationSearchParams } from "@/lib/url-state";

export const FINDING_PARAM = "finding";
export const DETAIL_TAB_PARAM = "tab";

export const DETAIL_TABS = ["overview", "repro", "occurrences", "explanations"] as const;

export type DetailTab = (typeof DETAIL_TABS)[number];

export const DEFAULT_DETAIL_TAB: DetailTab = "overview";

export const DETAIL_TAB_LABELS: Record<DetailTab, string> = {
  overview: "Overview",
  repro: "Repro",
  occurrences: "Occurrences",
  explanations: "Explanations",
};

export function parseDetailTab(raw: string | null | undefined): DetailTab {
  return DETAIL_TABS.find((tab) => tab === raw) ?? DEFAULT_DETAIL_TAB;
}

export function readOpenFindingId(params: URLSearchParams): string | null {
  const raw = params.get(FINDING_PARAM)?.trim() ?? "";
  return raw === "" ? null : raw;
}

export function openFindingSheet(findingId: string): void {
  const params = readLocationSearchParams();
  params.set(FINDING_PARAM, findingId);
  params.delete(DETAIL_TAB_PARAM);
  writeLocationSearchParams(params, { history: "push" });
}

export function closeFindingSheet(): void {
  const params = readLocationSearchParams();
  params.delete(FINDING_PARAM);
  params.delete(DETAIL_TAB_PARAM);
  writeLocationSearchParams(params, { history: "push" });
}

export function writeDetailTab(tab: DetailTab): void {
  const params = readLocationSearchParams();
  if (tab === DEFAULT_DETAIL_TAB) {
    params.delete(DETAIL_TAB_PARAM);
  } else {
    params.set(DETAIL_TAB_PARAM, tab);
  }
  writeLocationSearchParams(params, { history: "push" });
}
