import { toBundleSummary } from "../factories/bundles";
import { QueryReader, readPage, type Page, type PageSpec } from "../factories/pagination";
import { APP_KINDS } from "../handlers/targets";
import type { BundleRecord, StageOneStore, TargetRecord } from "../stage1/store";
import { libraryStore } from "./library-store";
import type { LibraryBundle } from "@/lib/api/types";

export const SEARCH_MAX_LENGTH = 200;

const LIBRARY_PAGE: PageSpec<LibraryBundle> = {
  sortKeys: { uploaded_at: { kind: "timestamp", value: (row) => row.uploaded_at } },
  defaultSort: "-uploaded_at",
  getId: (row) => row.id,
};

export function toLibraryBundle(record: BundleRecord, target: TargetRecord): LibraryBundle {
  return {
    ...toBundleSummary(record.bundle),
    app_kind: target.appKind,
    target_id: target.id,
    target_name: target.name,
  };
}

function matchesSearch(row: LibraryBundle, record: BundleRecord, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === "") {
    return true;
  }
  return [row.target_name, row.hash, record.bundle.note ?? ""].some((text) =>
    text.toLowerCase().includes(needle),
  );
}

export function listLibraryBundles(
  store: StageOneStore,
  searchParams: URLSearchParams,
): Page<LibraryBundle> {
  const query = new QueryReader(searchParams);
  const search = query.text("q", { max: SEARCH_MAX_LENGTH });
  const appKinds = query.enumList("app_kind", APP_KINDS);
  const targetId = query.uuid("target_id");
  const paginate = readPage(query, LIBRARY_PAGE);
  query.finish();
  if (libraryStore.mode === "empty") {
    return paginate([]);
  }
  libraryStore.ensureSeeded(store);
  const rows: LibraryBundle[] = [];
  for (const record of store.bundles) {
    const target = store.findTarget(record.bundle.target_id);
    if (target === undefined) {
      continue;
    }
    const row = toLibraryBundle(record, target);
    const kindMatches = appKinds === undefined || appKinds.includes(row.app_kind);
    const targetMatches = targetId === undefined || row.target_id === targetId.toLowerCase();
    if (kindMatches && targetMatches && matchesSearch(row, record, search ?? "")) {
      rows.push(row);
    }
  }
  return paginate(rows);
}
