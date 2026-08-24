import {
  createSearchParamsCodec,
  enumListParam,
  enumParam,
  stringListParam,
} from "@/lib/search-params";
import type { Confidence, ProposalItem, ProposalRisk } from "./types";
import { PROPOSAL_RISKS, PROPOSAL_SORTS, PROPOSAL_STATUSES, type ProposalSort } from "./labels";

export const DEFAULT_PROPOSAL_SORT: ProposalSort = "risk";

export const proposalFiltersCodec = createSearchParamsCodec(
  {
    risk: enumListParam(PROPOSAL_RISKS),
    status: enumListParam(PROPOSAL_STATUSES),
    area: stringListParam(),
    sort: enumParam(PROPOSAL_SORTS),
  },
  { defaults: { sort: DEFAULT_PROPOSAL_SORT } },
);

export const proposalFiltersSchema = proposalFiltersCodec.schema;

export type ProposalFilterValues = ReturnType<typeof proposalFiltersCodec.parse>;

export type ProposalFilterKey = keyof ProposalFilterValues;

const RISK_RANK: Record<ProposalRisk, number> = { high: 0, medium: 1, low: 2 };
const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export function applyProposalFilters(
  items: readonly ProposalItem[],
  values: Pick<ProposalFilterValues, "risk" | "status" | "area">,
): ProposalItem[] {
  return items.filter(
    (item) =>
      (values.risk === undefined || values.risk.includes(item.risk)) &&
      (values.status === undefined || values.status.includes(item.status)) &&
      (values.area === undefined || values.area.includes(item.area)),
  );
}

export function sortProposalItems(
  items: readonly ProposalItem[],
  sort: ProposalSort,
): ProposalItem[] {
  const compare = (left: ProposalItem, right: ProposalItem): number => {
    if (sort === "title") {
      return left.title.localeCompare(right.title);
    }
    if (sort === "confidence") {
      return (
        CONFIDENCE_RANK[left.confidence] - CONFIDENCE_RANK[right.confidence] ||
        RISK_RANK[left.risk] - RISK_RANK[right.risk]
      );
    }
    return RISK_RANK[left.risk] - RISK_RANK[right.risk];
  };
  return [...items].sort(compare);
}

export interface AreaGroup {
  area: string;
  items: ProposalItem[];
}

export function groupItemsByArea(items: readonly ProposalItem[]): AreaGroup[] {
  const groups = new Map<string, ProposalItem[]>();
  for (const item of items) {
    groups.set(item.area, [...(groups.get(item.area) ?? []), item]);
  }
  return [...groups]
    .map(([area, areaItems]) => ({ area, items: areaItems }))
    .sort((left, right) => left.area.localeCompare(right.area));
}

export function areaNamesOf(items: readonly ProposalItem[]): string[] {
  return [...new Set(items.map((item) => item.area))].sort((left, right) =>
    left.localeCompare(right),
  );
}
