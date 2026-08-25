import { areaSlug, type CoverageCellState } from "./coverage-data";
import type { TargetRecord } from "../stage1/store";

export const AUTHOR_TEMPLATE_VERSION = 1;

const EXAMPLE_REPEAT = 3;

function cellBlock(cell: CoverageCellState, index: number): string {
  const lines = [
    `### Cell ${index + 1}: ${cell.title}`,
    `- cell_id: ${cell.id}`,
    `- feature_id: ${cell.featureId}`,
    `- family: ${areaSlug(cell.area)}`,
    `- role: ${cell.role}`,
    `- interface_id: ${cell.interfaceId} (${cell.interfaceKind}, base path ${cell.basePath})`,
    `- status: ${cell.status}`,
  ];
  if (cell.reason !== null) {
    lines.push(`- why Tessa cannot write it: ${cell.reason}`);
  }
  lines.push(
    "- write one file: tessa/scenarios/" +
      `${cell.featureId.replaceAll(".", "-")}--${cell.role}--${cell.interfaceId}.yaml`,
  );
  for (let example = 1; example <= EXAMPLE_REPEAT; example += 1) {
    lines.push(
      `- check ${example}: describe what a correct answer for "${cell.title}" looks like for the ${cell.role} role`,
    );
  }
  return lines.join("\n");
}

export function renderAuthorPrompt(
  target: TargetRecord,
  cells: readonly CoverageCellState[],
  origin: string,
): string {
  const header = [
    `# Author scenarios for ${target.name}`,
    "",
    `Target token: ${target.targetToken}`,
    `Scenario schema: ${origin}/schemas/scenario.v1.json`,
    "",
    "Tessa could not write the scenarios below from the bundle examples. Read the code of this",
    "repository, then write one YAML file per cell under tessa/scenarios/ that validates against the",
    "schema. Use ${PLACEHOLDER} names for every credential and never paste a secret.",
    "",
    "When you are done, zip the tessa folder and upload it as the next bundle version.",
    "",
    `## Cells (${cells.length})`,
    "",
  ];
  return [...header, ...cells.map(cellBlock)].join("\n");
}
