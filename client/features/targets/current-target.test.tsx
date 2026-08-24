import { act, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { resetLocation } from "@/tests/utils/fake-navigation";
import {
  CURRENT_TARGET_STORAGE_KEY,
  destinationAfterSwitch,
  isTargetId,
  readLastTarget,
  rememberTarget,
  resolveCurrentTarget,
  targetIdFromPath,
  useCurrentTarget,
  useRememberCurrentTarget,
} from "./current-target";

vi.mock("next/navigation", async () => await import("@/tests/utils/fake-navigation"));

const GRACIE = STAGE_ONE_IDS.gracie;
const BILLING = STAGE_ONE_IDS.billing;
const SHOP = STAGE_ONE_IDS.liveShop;

function params(search: string): URLSearchParams {
  return new URLSearchParams(search);
}

function Probe() {
  const current = useCurrentTarget();
  return (
    <p data-testid="probe">
      {`${current.targetId ?? "none"}|${current.source ?? "none"}|${String(current.isResolved)}`}
    </p>
  );
}

function RememberingProbe() {
  useRememberCurrentTarget();
  return <Probe />;
}

function probeText(): string {
  return screen.getByTestId("probe").textContent ?? "";
}

beforeEach(() => {
  resetLocation("/");
  window.localStorage.clear();
  rememberTarget(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isTargetId and targetIdFromPath", () => {
  it("accepts only hyphenated UUIDs", () => {
    expect(isTargetId(GRACIE)).toBe(true);
    expect(isTargetId(GRACIE.toUpperCase())).toBe(true);
    expect(isTargetId("gracie")).toBe(false);
    expect(isTargetId(`${GRACIE}x`)).toBe(false);
    expect(isTargetId(null)).toBe(false);
    expect(isTargetId(undefined)).toBe(false);
  });

  it("reads the id from the target pages and ignores everything else", () => {
    expect(targetIdFromPath(`/targets/${GRACIE}`)).toBe(GRACIE);
    expect(targetIdFromPath(`/targets/${GRACIE}/bundles/abc`)).toBe(GRACIE);
    expect(targetIdFromPath("/targets/new")).toBeNull();
    expect(targetIdFromPath("/targets")).toBeNull();
    expect(targetIdFromPath("/catalog")).toBeNull();
    expect(targetIdFromPath(null)).toBeNull();
  });
});

describe("resolveCurrentTarget precedence", () => {
  it("lets ?target_id= win over the path and over the last used target", () => {
    expect(
      resolveCurrentTarget({
        searchParams: params(`target_id=${GRACIE}`),
        pathname: `/targets/${BILLING}`,
        stored: SHOP,
      }),
    ).toEqual({ targetId: GRACIE, source: "url" });
  });

  it("uses the target of a /targets/[id] page before the last used target", () => {
    expect(
      resolveCurrentTarget({
        searchParams: params(""),
        pathname: `/targets/${BILLING}/bundles`,
        stored: SHOP,
      }),
    ).toEqual({ targetId: BILLING, source: "path" });
  });

  it("falls back to the last used target", () => {
    expect(
      resolveCurrentTarget({ searchParams: params(""), pathname: "/catalog", stored: SHOP }),
    ).toEqual({ targetId: SHOP, source: "stored" });
  });

  it("ignores a malformed target_id and a malformed stored value", () => {
    expect(
      resolveCurrentTarget({
        searchParams: params("target_id=not-an-id"),
        pathname: "/catalog",
        stored: SHOP,
      }),
    ).toEqual({ targetId: SHOP, source: "stored" });
    expect(
      resolveCurrentTarget({
        searchParams: params("target_id=not-an-id"),
        pathname: "/catalog",
        stored: "junk",
      }),
    ).toEqual({ targetId: null, source: null });
  });

  it("resolves to nothing without a url, path or stored target", () => {
    expect(resolveCurrentTarget({ searchParams: null, pathname: "/", stored: null })).toEqual({
      targetId: null,
      source: null,
    });
  });
});

describe("useCurrentTarget", () => {
  it("reads the last used target from localStorage", () => {
    window.localStorage.setItem(CURRENT_TARGET_STORAGE_KEY, SHOP);

    render(<Probe />);

    expect(probeText()).toBe(`${SHOP}|stored|true`);
  });

  it("prefers the URL over localStorage and follows URL changes", () => {
    window.localStorage.setItem(CURRENT_TARGET_STORAGE_KEY, SHOP);
    resetLocation(`/catalog?target_id=${GRACIE}`);

    render(<Probe />);

    expect(probeText()).toBe(`${GRACIE}|url|true`);
  });

  it("reports unresolved with no target at all on the server snapshot", () => {
    window.localStorage.setItem(CURRENT_TARGET_STORAGE_KEY, SHOP);

    const html = renderToString(<Probe />);

    expect(html).toContain("none|none|false");
  });

  it("re-renders when the last used target changes, in this tab and from another tab", () => {
    render(<Probe />);
    expect(probeText()).toBe("none|none|true");

    act(() => rememberTarget(BILLING));
    expect(probeText()).toBe(`${BILLING}|stored|true`);

    act(() => {
      window.localStorage.setItem(CURRENT_TARGET_STORAGE_KEY, SHOP);
      window.dispatchEvent(new StorageEvent("storage", { key: CURRENT_TARGET_STORAGE_KEY }));
    });
    expect(probeText()).toBe(`${SHOP}|stored|true`);
  });

  it("keeps working in memory when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    render(<Probe />);
    expect(probeText()).toBe("none|none|true");

    act(() => rememberTarget(GRACIE));

    expect(probeText()).toBe(`${GRACIE}|stored|true`);
    expect(readLastTarget()).toBe(GRACIE);
  });
});

describe("rememberTarget", () => {
  it("stores a valid id, clears with null and refuses a malformed id", () => {
    rememberTarget(GRACIE);
    expect(window.localStorage.getItem(CURRENT_TARGET_STORAGE_KEY)).toBe(GRACIE);

    rememberTarget("junk");
    expect(window.localStorage.getItem(CURRENT_TARGET_STORAGE_KEY)).toBe(GRACIE);

    rememberTarget(null);
    expect(window.localStorage.getItem(CURRENT_TARGET_STORAGE_KEY)).toBeNull();
  });

  it("does not notify when nothing changed", () => {
    rememberTarget(GRACIE);
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    rememberTarget(GRACIE);

    expect(setItem).not.toHaveBeenCalled();
  });
});

describe("useRememberCurrentTarget", () => {
  it("remembers the target of the URL as the last used target", () => {
    resetLocation(`/catalog?target_id=${BILLING}`);

    render(<RememberingProbe />);

    expect(window.localStorage.getItem(CURRENT_TARGET_STORAGE_KEY)).toBe(BILLING);
  });

  it("remembers the target of a target page", () => {
    resetLocation(`/targets/${SHOP}/environment`);

    render(<RememberingProbe />);

    expect(window.localStorage.getItem(CURRENT_TARGET_STORAGE_KEY)).toBe(SHOP);
  });

  it("leaves the last used target alone when none is in the URL", () => {
    window.localStorage.setItem(CURRENT_TARGET_STORAGE_KEY, SHOP);

    render(<RememberingProbe />);

    expect(window.localStorage.getItem(CURRENT_TARGET_STORAGE_KEY)).toBe(SHOP);
  });
});

describe("destinationAfterSwitch", () => {
  it("moves a target page to the same tab of the new target", () => {
    expect(destinationAfterSwitch(`/targets/${GRACIE}`, params(""), BILLING)).toEqual({
      href: `/targets/${BILLING}`,
      replace: false,
    });
    expect(destinationAfterSwitch(`/targets/${GRACIE}/bundles`, params(""), BILLING)).toEqual({
      href: `/targets/${BILLING}/bundles`,
      replace: false,
    });
    expect(destinationAfterSwitch(`/targets/${GRACIE}/environment`, params(""), BILLING)).toEqual({
      href: `/targets/${BILLING}/environment`,
      replace: false,
    });
  });

  it("drops the bundle of the old target when switching from a bundle page", () => {
    expect(
      destinationAfterSwitch(`/targets/${GRACIE}/bundles/0198f6f2`, params(""), BILLING),
    ).toEqual({ href: `/targets/${BILLING}/bundles`, replace: false });
  });

  it("replaces target_id on pages that carry the target and drops other filters", () => {
    expect(
      destinationAfterSwitch("/catalog", params(`target_id=${GRACIE}&area=Rooms`), BILLING),
    ).toEqual({ href: `/catalog?target_id=${BILLING}`, replace: true });
    expect(destinationAfterSwitch("/runs", params(""), BILLING)).toEqual({
      href: `/runs?target_id=${BILLING}`,
      replace: true,
    });
  });

  it("only remembers the target on pages that do not carry one", () => {
    expect(destinationAfterSwitch("/targets", params(""), BILLING)).toBeNull();
    expect(destinationAfterSwitch("/settings", params(""), BILLING)).toBeNull();
    expect(destinationAfterSwitch("/targets/new", params(""), BILLING)).toBeNull();
  });
});
