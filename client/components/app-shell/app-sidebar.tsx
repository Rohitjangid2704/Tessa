"use client";

import { ScanSearch } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { canDo, useCurrentRole } from "@/lib/auth/can";
import { routes } from "@/lib/routes";
import { NAV_GROUPS, isNavItemActive, navHref, visibleNavGroups } from "./nav-items";
import type { ShellUser } from "./user-display";
import { UserMenu } from "./user-menu";

export type AppSidebarProps = {
  user: ShellUser;
  targetId?: string | null;
};

export function AppSidebar({ user, targetId = null }: AppSidebarProps) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const closeMobileSidebar = () => setOpenMobile(false);
  const homeActive = isNavItemActive(routes.home, pathname);
  const { role } = useCurrentRole();
  const groups = visibleNavGroups(NAV_GROUPS, (action) => canDo(role, action));

  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" isActive={homeActive}>
              <Link
                href={routes.home}
                aria-label="Tessa home"
                aria-current={homeActive ? "page" : undefined}
                onClick={closeMobileSidebar}
              >
                <span className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <ScanSearch aria-hidden="true" className="size-4" />
                </span>
                <span className="text-base font-semibold">Tessa</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Main" className="flex flex-col">
          {groups.map((group) => (
            <SidebarGroup key={group.id} data-nav-group={group.id}>
              {group.label === null ? null : <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => {
                    const active = isNavItemActive(item.href, pathname);
                    return (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
                          <Link
                            href={navHref(item, targetId)}
                            aria-current={active ? "page" : undefined}
                            onClick={closeMobileSidebar}
                          >
                            <item.icon aria-hidden="true" />
                            <span>{item.label}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
      <SidebarFooter>
        <UserMenu user={user} />
      </SidebarFooter>
    </Sidebar>
  );
}
