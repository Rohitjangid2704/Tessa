import { startTransition } from "react";
import { toast } from "sonner";
import { getQueryClient } from "@/lib/api/query-client";
import { clearToken } from "./token-client";

export type RejectedSessionReason = "deactivated" | "invalid";

export const SESSION_REJECTED_TOAST_ID = "session-rejected";
export const SESSION_REJECTED_TOAST_DURATION_MS = 15_000;

export const REJECTED_SESSION_MESSAGES: Record<
  RejectedSessionReason,
  { title: string; description: string }
> = {
  deactivated: {
    title: "Your account has been deactivated",
    description: "You were signed out. Ask an admin to reactivate your account.",
  },
  invalid: {
    title: "Your session is no longer valid",
    description: "You were signed out. Sign in again to continue.",
  },
};

let signingOut = false;

export function signOutRejectedSession(
  reason: RejectedSessionReason,
  onSignOutFailed: () => void,
): void {
  if (typeof window === "undefined" || signingOut) {
    return;
  }
  signingOut = true;
  clearToken();
  getQueryClient().clear();
  const message = REJECTED_SESSION_MESSAGES[reason];
  toast.error(message.title, {
    id: SESSION_REJECTED_TOAST_ID,
    description: message.description,
    duration: SESSION_REJECTED_TOAST_DURATION_MS,
  });
  startTransition(async () => {
    try {
      const { logoutAction } = await import("@/app/(auth)/login/actions");
      await logoutAction();
    } catch {
      signingOut = false;
      onSignOutFailed();
    }
  });
}
