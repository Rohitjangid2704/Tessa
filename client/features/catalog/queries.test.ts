import { QueryClient } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/lib/api/query-keys";
import { buildCatalog, buildCatalogItem, groupByArea } from "@/mocks/factories/catalog";
import { MEMBER_USER } from "@/mocks/factories/users";
import { STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { signInAs } from "@/tests/utils/api-session";
import { server } from "@/tests/utils/server";
import {
  areaTotals,
  catalogQuery,
  hasNoCatalogContent,
  itemCount,
  keepCatalogWithinScope,
} from "./queries";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const { gracie } = STAGE_ONE_IDS;
const BUNDLE_ID = "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b7777";

beforeEach(async () => {
  await signInAs(MEMBER_USER);
});

describe("qk.catalog", () => {
  it("lives under the catalog root so a bundle intake invalidates it", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(qk.catalog(gracie, null, { kind: ["read"] }), buildCatalog());
    queryClient.setQueryData(qk.catalog(gracie, BUNDLE_ID, {}), buildCatalog());

    expect(qk.catalog(gracie, null, {}).slice(0, qk.catalogRoot().length)).toEqual(
      qk.catalogRoot(),
    );
    await queryClient.invalidateQueries({ queryKey: qk.catalogRoot() });

    expect(
      queryClient.getQueryState(qk.catalog(gracie, null, { kind: ["read"] }))?.isInvalidated,
    ).toBe(true);
    expect(queryClient.getQueryState(qk.catalog(gracie, BUNDLE_ID, {}))?.isInvalidated).toBe(true);
  });

  it("separates targets, bundles and filters", () => {
    const base = qk.catalog(gracie, null, {});

    expect(JSON.stringify(qk.catalog(gracie, null, { q: "x" }))).not.toBe(JSON.stringify(base));
    expect(JSON.stringify(qk.catalog(gracie, BUNDLE_ID, {}))).not.toBe(JSON.stringify(base));
    expect(JSON.stringify(qk.catalog("other", null, {}))).not.toBe(JSON.stringify(base));
  });
});

describe("catalogQuery", () => {
  it("sends the target and every filter as query parameters", async () => {
    let received: URL | null = null;
    server.use(
      http.get("*/api/v1/catalog", ({ request }) => {
        received = new URL(request.url);
        return HttpResponse.json(buildCatalog());
      }),
    );
    const queryClient = new QueryClient();

    await queryClient.fetchQuery(
      catalogQuery({
        targetId: gracie,
        bundleId: BUNDLE_ID,
        filters: {
          q: "refund",
          area: ["Smart Log", "Reports"],
          kind: ["read", "write"],
          role: ["guest"],
          interface_id: ["chat_sse"],
          confidence: ["high"],
        },
      }),
    );

    const url = received as URL | null;
    expect(url?.searchParams.get("target_id")).toBe(gracie);
    expect(url?.searchParams.get("bundle_id")).toBe(BUNDLE_ID);
    expect(url?.searchParams.get("q")).toBe("refund");
    expect(url?.searchParams.getAll("area")).toEqual(["Smart Log", "Reports"]);
    expect(url?.searchParams.getAll("kind")).toEqual(["read", "write"]);
    expect(url?.searchParams.getAll("role")).toEqual(["guest"]);
    expect(url?.searchParams.getAll("interface_id")).toEqual(["chat_sse"]);
    expect(url?.searchParams.getAll("confidence")).toEqual(["high"]);
  });

  it("sends only the target when there are no filters", async () => {
    let received: URL | null = null;
    server.use(
      http.get("*/api/v1/catalog", ({ request }) => {
        received = new URL(request.url);
        return HttpResponse.json(buildCatalog());
      }),
    );

    await new QueryClient().fetchQuery(
      catalogQuery({ targetId: gracie, bundleId: null, filters: {} }),
    );

    expect([...((received as URL | null)?.searchParams.keys() ?? [])]).toEqual(["target_id"]);
  });
});

describe("keepCatalogWithinScope", () => {
  const previous = buildCatalog({ bundle_id: BUNDLE_ID, bundle_version: 1 });

  it("keeps the previous catalog while filters change inside one target and bundle", () => {
    const keep = keepCatalogWithinScope({ targetId: gracie, bundleId: null });

    expect(keep(previous, { queryKey: qk.catalog(gracie, null, { q: "a" }) })).toBe(previous);
  });

  it("drops it when the target or the bundle changes", () => {
    const keep = keepCatalogWithinScope({ targetId: gracie, bundleId: null });

    expect(keep(previous, { queryKey: qk.catalog("other", null, {}) })).toBeUndefined();
    expect(keep(previous, { queryKey: qk.catalog(gracie, BUNDLE_ID, {}) })).toBeUndefined();
    expect(keep(undefined, undefined)).toBeUndefined();
  });
});

describe("catalog helpers", () => {
  const catalog = buildCatalog({
    bundle_id: BUNDLE_ID,
    areas: groupByArea([
      buildCatalogItem({ area: "A" }),
      buildCatalogItem({ area: "A" }),
      buildCatalogItem({ area: "B" }),
    ]),
  });

  it("counts items and areas", () => {
    expect(itemCount(catalog)).toBe(3);
    expect(itemCount(undefined)).toBe(0);
    expect([...areaTotals(catalog)]).toEqual([
      ["A", 2],
      ["B", 1],
    ]);
    expect(areaTotals(undefined).size).toBe(0);
  });

  it("detects the empty shape of an invalid or missing bundle", () => {
    expect(hasNoCatalogContent(buildCatalog())).toBe(true);
    expect(hasNoCatalogContent(buildCatalog({ bundle_id: BUNDLE_ID, bundle_version: 3 }))).toBe(
      true,
    );
    expect(hasNoCatalogContent(catalog)).toBe(false);
    expect(
      hasNoCatalogContent(
        buildCatalog({ roles: [{ id: "guest", level: 0, description: "Guest" }] }),
      ),
    ).toBe(false);
  });
});
