import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { NAV_ITEMS } from "@/components/app-shell/nav-items";
import { toRoute } from "@/lib/routes";
import { useHydrated } from "@/lib/use-hydrated";
import { targetOptionsQuery } from "./queries";
import { isTargetScopedParam } from "./target-scoped-params";
import type { TargetSummary } from "./types";

export const CURRENT_TARGET_STORAGE_KEY = "tessa.current-target";
export const TARGET_ID_PARAM = "target_id";

const TARGET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TARGET_PATH_PATTERN = /^\/targets\/([0-9a-f-]{36})(?:\/([^/]+))?/i;
const TARGET_TABS = ["bundles", "environment", "proposal"] as const;
const NO_SEARCH_PARAMS = new URLSearchParams();
const TARGET_PAGES = NAV_ITEMS.filter((item) => item.carriesTarget).map((item) => item.href);

export type CurrentTargetSource = "url" | "path" | "stored" | "default";

export interface ResolvedTarget {
  targetId: string | null;
  source: CurrentTargetSource | null;
}

export interface CurrentTarget extends ResolvedTarget {
  isResolved: boolean;
}

export function isTargetId(value: unknown): value is string {
  return typeof value === "string" && TARGET_ID_PATTERN.test(value);
}

export function targetIdFromPath(pathname: string | null | undefined): string | null {
  const match = TARGET_PATH_PATTERN.exec(pathname ?? "");
  const candidate = match?.[1];
  return isTargetId(candidate) ? candidate : null;
}

export interface ResolveInput {
  searchParams: { get: (name: string) => string | null } | null;
  pathname: string | null | undefined;
  stored: string | null;
}

export function resolveCurrentTarget({
  searchParams,
  pathname,
  stored,
}: ResolveInput): ResolvedTarget {
  const fromUrl = searchParams?.get(TARGET_ID_PARAM) ?? null;
  if (isTargetId(fromUrl)) {
    return { targetId: fromUrl, source: "url" };
  }
  const fromPath = targetIdFromPath(pathname);
  if (fromPath !== null) {
    return { targetId: fromPath, source: "path" };
  }
  if (isTargetId(stored)) {
    return { targetId: stored, source: "stored" };
  }
  return { targetId: null, source: null };
}

const listeners = new Set<() => void>();
let memoryTarget: string | null = null;

function notifyListeners(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

function readStoredTarget(): string | null {
  try {
    const value = window.localStorage.getItem(CURRENT_TARGET_STORAGE_KEY);
    if (isTargetId(value)) {
      return value;
    }
  } catch {
    return memoryTarget;
  }
  return memoryTarget;
}

function writeStoredTarget(targetId: string | null): boolean {
  try {
    if (targetId === null) {
      window.localStorage.removeItem(CURRENT_TARGET_STORAGE_KEY);
    } else {
      window.localStorage.setItem(CURRENT_TARGET_STORAGE_KEY, targetId);
    }
    return true;
  } catch {
    return false;
  }
}

export function readLastTarget(): string | null {
  return readStoredTarget();
}

export function rememberTarget(targetId: string | null): void {
  if (targetId !== null && !isTargetId(targetId)) {
    return;
  }
  if (readStoredTarget() === targetId) {
    return;
  }
  memoryTarget = writeStoredTarget(targetId) ? null : targetId;
  notifyListeners();
}

function subscribeToStoredTarget(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === CURRENT_TARGET_STORAGE_KEY) {
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

const readNoStoredTargetOnServer = (): null => null;

export function defaultTargetId(
  targets: readonly Pick<TargetSummary, "id" | "archived_at" | "created_at">[] | undefined,
): string | null {
  const active = (targets ?? []).filter((target) => target.archived_at == null);
  const oldest = active.reduce<(typeof active)[number] | undefined>(
    (best, target) =>
      best === undefined || Date.parse(target.created_at) < Date.parse(best.created_at)
        ? target
        : best,
    undefined,
  );
  return oldest?.id ?? null;
}

export function useCurrentTarget(): CurrentTarget {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const hydrated = useHydrated();
  const stored = useSyncExternalStore(
    subscribeToStoredTarget,
    readStoredTarget,
    readNoStoredTargetOnServer,
  );
  const resolved = resolveCurrentTarget({ searchParams, pathname, stored });
  const needsDefault = resolved.targetId === null;
  const options = useQuery({ ...targetOptionsQuery(), enabled: hydrated && needsDefault });
  if (!needsDefault) {
    return { ...resolved, isResolved: true };
  }
  const fallbackId = defaultTargetId(options.data);
  if (fallbackId !== null) {
    return { targetId: fallbackId, source: "default", isResolved: true };
  }
  return { targetId: null, source: null, isResolved: hydrated && !options.isPending };
}

export function useCurrentTargetId(): string | null {
  return useCurrentTarget().targetId;
}

export function useRememberCurrentTarget(): void {
  const { targetId, source } = useCurrentTarget();
  useEffect(() => {
    if (targetId !== null && (source === "url" || source === "path")) {
      rememberTarget(targetId);
    }
  }, [targetId, source]);
}

export interface SwitchDestination {
  href: string;
  replace: boolean;
}

export interface SwitchSearchParams {
  has: (name: string) => boolean;
  entries: () => Iterable<[string, string]>;
}

function pageSectionOf(pathname: string): string | undefined {
  return TARGET_PAGES.find((base) => pathname === base || pathname.startsWith(`${base}/`));
}

function isEntityPage(pathname: string, section: string): boolean {
  const [first] = pathname.slice(section.length).split("/").filter(Boolean);
  return isTargetId(first);
}

export function destinationAfterSwitch(
  pathname: string,
  searchParams: SwitchSearchParams,
  nextTargetId: string,
): SwitchDestination | null {
  const match = TARGET_PATH_PATTERN.exec(pathname);
  if (match !== null) {
    const tab = TARGET_TABS.find((candidate) => candidate === match[2]);
    return { href: `/targets/${nextTargetId}${tab ? `/${tab}` : ""}`, replace: false };
  }
  const section = pageSectionOf(pathname);
  if (section === undefined && !searchParams.has(TARGET_ID_PARAM)) {
    return null;
  }
  if (section !== undefined && isEntityPage(pathname, section)) {
    return { href: `${section}?${TARGET_ID_PARAM}=${nextTargetId}`, replace: false };
  }
  const kept = new URLSearchParams();
  kept.set(TARGET_ID_PARAM, nextTargetId);
  for (const [key, value] of searchParams.entries()) {
    if (key !== TARGET_ID_PARAM && !isTargetScopedParam(key)) {
      kept.append(key, value);
    }
  }
  return { href: `${pathname}?${kept.toString()}`, replace: true };
}

export function useSwitchTarget(): (targetId: string) => void {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams() ?? NO_SEARCH_PARAMS;
  return (targetId) => {
    rememberTarget(targetId);
    const destination = destinationAfterSwitch(pathname, searchParams, targetId);
    if (destination === null) {
      return;
    }
    const href = toRoute(destination.href);
    if (destination.replace) {
      router.replace(href);
    } else {
      router.push(href);
    }
  };
}
