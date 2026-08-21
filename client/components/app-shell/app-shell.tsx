import type { ReactNode } from "react";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "./app-sidebar";
import type { ShellUser } from "./user-display";

export const MAIN_CONTENT_ID = "main-content";

export type AppShellProps = {
  user: ShellUser;
  defaultOpen?: boolean;
  targetId?: string | null;
  headerActions?: ReactNode;
  headerEnd?: ReactNode;
  banner?: ReactNode;
  children: ReactNode;
};

export function AppShell({
  user,
  defaultOpen = true,
  targetId = null,
  headerActions,
  headerEnd,
  banner,
  children,
}: AppShellProps) {
  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <a
        href={`#${MAIN_CONTENT_ID}`}
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:shadow-md focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <AppSidebar user={user} targetId={targetId} />
      <SidebarInset id={MAIN_CONTENT_ID} tabIndex={-1} className="min-w-0 outline-none">
        <div className="sticky top-0 z-10 flex h-12 items-center gap-2 border-b bg-background px-4">
          <SidebarTrigger />
          {headerActions}
          {headerEnd === undefined ? null : (
            <div data-slot="header-end" className="ml-auto flex items-center gap-1">
              {headerEnd}
            </div>
          )}
        </div>
        {banner === undefined ? null : (
          <div data-slot="app-banner" className="sticky top-12 z-10">
            {banner}
          </div>
        )}
        <div className="mx-auto w-full max-w-6xl flex-1 p-4 md:p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
