import { loginPath, routes } from "@/lib/routes";
import { safeCallbackPath } from "./safe-redirect";

export type GateInput = {
  pathname: string;
  search: string;
  isAuthenticated: boolean;
  callbackUrl: string | null;
};

export type GateDecision = { action: "next" } | { action: "redirect"; location: string };

export function decideGate(input: GateInput): GateDecision {
  if (input.pathname === routes.login) {
    return input.isAuthenticated
      ? { action: "redirect", location: safeCallbackPath(input.callbackUrl) }
      : { action: "next" };
  }
  if (!input.isAuthenticated) {
    return { action: "redirect", location: loginPath(`${input.pathname}${input.search}`) };
  }
  return { action: "next" };
}
