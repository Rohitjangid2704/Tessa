"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronsUpDown, LogOut } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { meQuery } from "@/features/system/queries";
import { useLogout } from "@/lib/auth/use-logout";
import { userDisplayName, userInitials, type ShellUser } from "./user-display";

export function UserMenu({ user }: { user: ShellUser }) {
  const me = useQuery(meQuery());
  const { logout, pending } = useLogout();
  const shown: ShellUser = me.data ? { name: me.data.name, email: me.data.email } : user;

  return (
    <div className="flex items-center gap-1">
      <SidebarMenu className="min-w-0 flex-1">
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
                <Avatar size="sm">
                  <AvatarFallback>{userInitials(shown)}</AvatarFallback>
                </Avatar>
                <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{userDisplayName(shown)}</span>
                  <span className="truncate text-xs text-sidebar-foreground/70">{shown.email}</span>
                </span>
                <ChevronsUpDown aria-hidden="true" className="ml-auto size-4" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="min-w-56">
              <DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
                <span className="truncate font-medium text-foreground">
                  {userDisplayName(shown)}
                </span>
                <span className="truncate text-xs text-muted-foreground">{shown.email}</span>
                {me.data ? (
                  <span className="text-xs text-muted-foreground">Role: {me.data.role}</span>
                ) : null}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={pending} onSelect={logout}>
                <LogOut aria-hidden="true" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
      <ThemeToggle />
    </div>
  );
}
