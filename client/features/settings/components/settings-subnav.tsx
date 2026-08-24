"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { canDo, useCurrentRole } from "@/lib/auth/can";
import { cn } from "@/lib/utils";
import { isSettingsSectionActive, isSettingsSectionVisible, SETTINGS_SECTIONS } from "../sections";

export function SettingsSubnav() {
  const pathname = usePathname();
  const { role } = useCurrentRole();
  const visibleSections = SETTINGS_SECTIONS.filter((section) =>
    isSettingsSectionVisible(section, (action) => canDo(role, action)),
  );
  return (
    <nav aria-label="Settings sections" data-slot="settings-subnav">
      <ul className="flex flex-wrap gap-1 border-b pb-2">
        {visibleSections.map((section) => {
          const active = isSettingsSectionActive(section, pathname);
          return (
            <li key={section.id}>
              <Link
                href={section.href}
                aria-current={active ? "page" : undefined}
                data-section-link={section.id}
                className={cn(
                  "inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  active
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
