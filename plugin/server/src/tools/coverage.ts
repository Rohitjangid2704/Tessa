import { z } from "zod";
import { unwrap } from "../client";
import { cutValue } from "../cut";
import { asList } from "./args";
import { defineTool } from "./define";

export const MAX_COVERAGE_CELLS = 500;
const CELLS_BUDGET_BYTES = 55_000;
const REASON_BYTES = 160;
const CELL_STATUSES = ["empty", "generated", "covered", "needs_author", "blocked"] as const;

type Cell = {
  id: string;
  feature_id: string;
  role: string;
  interface_id: string;
  family: string;
  status: string;
  scenario_count: number;
  last_verdict?: string | null;
  reason?: string | null;
  skip_reason?: string | null;
  proposal_item_ids?: string[];
};

function compactCell(cell: Cell) {
  const compact: Record<string, unknown> = {
    id: cell.id,
    feature_id: cell.feature_id,
    role: cell.role,
    interface_id: cell.interface_id,
    family: cell.family,
    status: cell.status,
    scenario_count: cell.scenario_count,
  };
  if (cell.last_verdict) {
    compact.last_verdict = cell.last_verdict;
  }
  if (cell.reason) {
    compact.reason = cutValue(cell.reason, REASON_BYTES).value;
  }
  if (cell.skip_reason) {
    compact.skip_reason = cell.skip_reason;
  }
  if (cell.proposal_item_ids && cell.proposal_item_ids.length > 0) {
    compact.proposal_item_ids = cell.proposal_item_ids;
  }
  return compact;
}

export const getCoverage = defineTool({
  name: "get_coverage",
  title: "Get coverage",
  description:
    "Read. The coverage map of a target for the baseline plan of its latest valid bundle: totals per cell status (empty, generated, covered, needs_author, blocked) and the cells, each one a feature used by one role on one interface with its status, scenario count, reason and the proposal items that map to it. Filter by status or area. At most 500 cells are returned, fewer when the result would be large; when truncated is true, call again with offset set to next_offset or narrow with a filter. Cell ids are what the author prompt takes.",
  access: "read",
  input: {
    target_id: z.string().uuid(),
    status: z.union([z.enum(CELL_STATUSES), z.array(z.enum(CELL_STATUSES)).min(1)]).optional(),
    area: z.union([z.string().min(1).max(120), z.array(z.string().min(1).max(120)).min(1)]).optional(),
    offset: z.number().int().min(0).optional().describe("Skip this many cells of the filtered map"),
  },
  async handler(context, args) {
    const map = await unwrap(
      context.api.client.GET("/api/v1/coverage", {
        params: {
          query: {
            target_id: args.target_id,
            status: asList(args.status),
            area: asList(args.area),
          },
        },
      }),
    );
    const offset = args.offset ?? 0;
    const limited = map.cells.slice(offset, offset + MAX_COVERAGE_CELLS);
    const kept: Array<Record<string, unknown>> = [];
    let bytes = 0;
    for (const cell of limited) {
      const compact = compactCell(cell);
      const size = Buffer.byteLength(JSON.stringify(compact));
      if (bytes + size > CELLS_BUDGET_BYTES) {
        break;
      }
      bytes += size;
      kept.push(compact);
    }
    return {
      target_id: map.target_id,
      plan_id: map.plan_id,
      bundle_id: map.bundle_id,
      totals: map.totals,
      cells_total: map.cells.length,
      rows: map.rows.length,
      columns: map.columns.length,
      cells: kept,
      cells_returned: kept.length,
      offset,
      truncated: offset + kept.length < map.cells.length,
      next_offset: offset + kept.length < map.cells.length ? offset + kept.length : null,
    };
  },
});
