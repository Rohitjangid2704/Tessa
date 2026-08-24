import type { Route } from "next";
import { toRoute } from "@/lib/routes";

const SAFE_APP_LINK = /^\/(?![/\\])[^\s\\]*$/;

export function isSafeAppLink(link: string): boolean {
  return SAFE_APP_LINK.test(link);
}

export function safeAppRoute(link: string): Route | null {
  return isSafeAppLink(link) ? toRoute(link) : null;
}
