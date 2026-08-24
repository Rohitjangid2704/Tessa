"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { createStore, useStoreSelector, type Store } from "@/lib/store";
import { toRoute } from "@/lib/routes";

type DirtySections = ReadonlySet<string>;

const DirtySectionsContext = createContext<Store<DirtySections> | null>(null);

export function DirtySectionsProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => createStore<DirtySections>(new Set()));
  return <DirtySectionsContext value={store}>{children}</DirtySectionsContext>;
}

export function useReportDirty(section: string, dirty: boolean): void {
  const store = useContext(DirtySectionsContext);
  useEffect(() => {
    if (store === null || !dirty) {
      return;
    }
    store.update((current) => new Set(current).add(section));
    return () => {
      store.update((current) => {
        const next = new Set(current);
        next.delete(section);
        return next;
      });
    };
  }, [store, section, dirty]);
}

const NEVER_DIRTY: Store<DirtySections> = createStore<DirtySections>(new Set());

export function useAnyDirty(): boolean {
  const store = useContext(DirtySectionsContext) ?? NEVER_DIRTY;
  return useStoreSelector(store, (sections) => sections.size > 0);
}

export function leavingDestination(event: MouseEvent): string | null {
  if (event.defaultPrevented || event.button !== 0) {
    return null;
  }
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return null;
  }
  const target = event.target;
  if (!(target instanceof Element)) {
    return null;
  }
  const anchor = target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) {
    return null;
  }
  const opensHere = anchor.target === "" || anchor.target === "_self";
  if (!opensHere || anchor.hasAttribute("download")) {
    return null;
  }
  const destination = new URL(anchor.href, window.location.href);
  const { location } = window;
  if (destination.origin !== location.origin) {
    return null;
  }
  if (destination.pathname === location.pathname && destination.search === location.search) {
    return null;
  }
  return `${destination.pathname}${destination.search}${destination.hash}`;
}

export function UnsavedChangesGuard() {
  const dirty = useAnyDirty();
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

  function discardAndLeave(): void {
    const destination = pendingDestination;
    setPendingDestination(null);
    if (destination !== null) {
      leaving.current = true;
      router.push(toRoute(destination));
    }
  }

  return (
    <AlertDialog
      open={pendingDestination !== null}
      onOpenChange={(open) => {
        if (!open) {
          setPendingDestination(null);
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
          <AlertDialogDescription>
            Some settings have edits that are not saved. Leaving this page discards them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <AlertDialogAction onClick={discardAndLeave}>Discard and leave</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
