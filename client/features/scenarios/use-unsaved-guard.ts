import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { leavingDestination } from "@/features/settings/unsaved-changes";
import { toRoute } from "@/lib/routes";

export interface UnsavedGuard {
  pendingDestination: string | null;
  isPrompting: boolean;
  stay: () => void;
  discardAndLeave: () => void;
}

export function useUnsavedGuard(dirty: boolean): UnsavedGuard {
  const router = useRouter();
  const [pendingDestination, setPendingDestination] = useState<string | null>(null);
  const leaving = useRef(false);

  useEffect(() => {
    if (!dirty) {
      return;
    }
    function warnBeforeUnload(event: BeforeUnloadEvent): void {
      if (!leaving.current) {
        event.preventDefault();
      }
    }
    function interceptLinkClick(event: MouseEvent): void {
      if (leaving.current) {
        return;
      }
      const destination = leavingDestination(event);
      if (destination === null) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      setPendingDestination(destination);
    }
    window.addEventListener("beforeunload", warnBeforeUnload);
    document.addEventListener("click", interceptLinkClick, true);
    return () => {
      window.removeEventListener("beforeunload", warnBeforeUnload);
      document.removeEventListener("click", interceptLinkClick, true);
    };
  }, [dirty]);

  function stay(): void {
    setPendingDestination(null);
  }

  function discardAndLeave(): void {
    const destination = pendingDestination;
    setPendingDestination(null);
    if (destination !== null) {
      leaving.current = true;
      router.push(toRoute(destination));
    }
  }

  return { pendingDestination, isPrompting: pendingDestination !== null, stay, discardAndLeave };
}
