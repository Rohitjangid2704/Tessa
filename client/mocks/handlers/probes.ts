import { http } from "msw";
import { QueryReader, readPage, type PageSpec } from "../factories/pagination";
import { stageFour } from "../stage4/support";
import type { Probe } from "@/lib/api/types";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

export const PROBE_PACKS = ["generic", "llm_app", "target"] as const;

const SEARCH_MAX = 200;

const PROBE_PAGE: PageSpec<Probe> = {
  sortKeys: {
    id: { kind: "text", value: (row) => row.id },
    pack: { kind: "text", value: (row) => row.pack },
  },
  defaultSort: "id",
  getId: (row) => row.id,
};

async function listProbes(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const query = new QueryReader(context.url.searchParams);
  const packs = query.enumList("pack", PROBE_PACKS);
  const text = query.text("q", { max: SEARCH_MAX });
  const paginate = readPage(query, PROBE_PAGE);
  query.finish();

  const needle = text?.toLowerCase();
  const rows = stageFour(context)
    .probes.probes.filter((probe) => packs === undefined || packs.includes(probe.pack))
    .filter(
      (probe) =>
        needle === undefined ||
        probe.id.toLowerCase().includes(needle) ||
        probe.question.toLowerCase().includes(needle),
    );
  return jsonResponse(paginate(rows));
}

export const probeHandlers = [http.get("*/api/v1/probes", api(listProbes))];
