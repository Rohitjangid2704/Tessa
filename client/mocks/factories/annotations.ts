import type { CoverageCell, ProposalRisk } from "@/lib/api/types";

export type CoverageCellAnnotator = (
  targetId: string,
  cells: readonly CoverageCell[],
) => CoverageCell[];

export type CatalogRiskResolver = (targetId: string, featureId: string) => ProposalRisk | null;

let coverageCellAnnotator: CoverageCellAnnotator | undefined;
let catalogRiskResolver: CatalogRiskResolver | undefined;

export function installCoverageCellAnnotator(annotator: CoverageCellAnnotator): void {
  coverageCellAnnotator = annotator;
}

export function installCatalogRiskResolver(resolver: CatalogRiskResolver): void {
  catalogRiskResolver = resolver;
}

export function annotateCoverageCells(
  targetId: string,
  cells: readonly CoverageCell[],
): CoverageCell[] {
  return coverageCellAnnotator === undefined ? [...cells] : coverageCellAnnotator(targetId, cells);
}

export function catalogRiskOf(targetId: string, featureId: string): ProposalRisk | null {
  return catalogRiskResolver === undefined ? null : catalogRiskResolver(targetId, featureId);
}
