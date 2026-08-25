import { http } from "msw";
import { catalogRiskOf } from "../factories/annotations";
import { groupByArea, type Catalog, type CatalogItem } from "../factories/catalog";
import { notFound } from "../factories/errors";
import { QueryReader } from "../factories/pagination";
import { pathUuid, requireTarget, stageOne } from "../stage1/support";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

export const FEATURE_KINDS = ["read", "write", "flow", "auth", "admin", "stream", "job"] as const;
export const CONFIDENCES = ["low", "medium", "high"] as const;

const SEARCH_MAX = 200;
const ALL_ROLES = "all";

interface CatalogFilters {
  areas?: string[];
  kinds?: string[];
  roles?: string[];
  interfaceIds?: string[];
  confidences?: string[];
  text?: string;
}

function withProposalRisk(targetId: string, items: CatalogItem[]): CatalogItem[] {
  return items.map((item) => {
    const risk = catalogRiskOf(targetId, item.feature_id);
    return risk === null ? item : { ...item, proposal_risk: risk };
  });
}

function matches(item: CatalogItem, filters: CatalogFilters): boolean {
  const needle = filters.text?.toLowerCase();
  return (
    (filters.areas === undefined || filters.areas.includes(item.area)) &&
    (filters.kinds === undefined || filters.kinds.includes(item.kind)) &&
    (filters.roles === undefined ||
      item.roles.includes(ALL_ROLES) ||
      filters.roles.some((role) => item.roles.includes(role))) &&
    (filters.interfaceIds === undefined ||
      filters.interfaceIds.some((id) => item.interface_ids.includes(id))) &&
    (filters.confidences === undefined || filters.confidences.includes(item.confidence)) &&
    (needle === undefined ||
      item.feature_id.toLowerCase().includes(needle) ||
      item.description.toLowerCase().includes(needle) ||
      item.area.toLowerCase().includes(needle))
  );
}

async function readCatalog(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const query = new QueryReader(context.url.searchParams);
  const targetId = query.uuid("target_id", { required: true });
  const bundleId = query.uuid("bundle_id");
  const filters: CatalogFilters = {
    areas: query.stringList("area"),
    kinds: query.enumList("kind", FEATURE_KINDS),
    roles: query.stringList("role"),
    interfaceIds: query.stringList("interface_id"),
    confidences: query.enumList("confidence", CONFIDENCES),
    text: query.text("q", { max: SEARCH_MAX })?.trim(),
  };
  query.finish();

  const store = stageOne(context);
  const target = requireTarget(context, targetId as string);
  const record =
    bundleId === undefined ? store.latestValidBundle(target.id) : store.findBundle(bundleId);
  if (bundleId !== undefined && (record === undefined || record.bundle.target_id !== target.id)) {
    throw notFound("Bundle not found");
  }
  if (record === undefined) {
    const empty: Catalog = {
      bundle_id: null,
      bundle_version: null,
      roles: [],
      interfaces: [],
      areas: [],
    };
    return jsonResponse(empty);
  }
  if (record.bundle.validation_status !== "valid") {
    const echoed: Catalog = {
      bundle_id: record.bundle.id,
      bundle_version: record.bundle.version,
      roles: [],
      interfaces: [],
      areas: [],
    };
    return jsonResponse(echoed);
  }
  const body: Catalog = {
    bundle_id: record.bundle.id,
    bundle_version: record.bundle.version,
    roles: record.roles.map((role) => ({ ...role })),
    interfaces: record.interfaces.map((entry) => ({ ...entry })),
    areas: groupByArea(
      withProposalRisk(
        target.id,
        record.features.filter((item) => matches(item, filters)),
      ),
    ).sort(
      (left, right) =>
        left.name.toLowerCase().localeCompare(right.name.toLowerCase()) ||
        left.name.localeCompare(right.name),
    ),
  };
  return jsonResponse(body);
}

async function readCatalogItem(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const itemId = pathUuid(context, "catalog_item_id");
  for (const record of stageOne(context).bundles) {
    const item = record.features.find((candidate) => candidate.id === itemId);
    if (item !== undefined) {
      return jsonResponse(withProposalRisk(record.bundle.target_id, [item])[0] ?? item);
    }
  }
  throw notFound("Catalog item not found");
}

export const catalogHandlers = [
  http.get("*/api/v1/catalog", api(readCatalog)),
  http.get("*/api/v1/catalog/items/:catalog_item_id", api(readCatalogItem)),
];
