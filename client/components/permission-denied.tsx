"use client";

import { Lock, LockKeyhole } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useCurrentRole } from "@/lib/auth/can";
import { requiredRoleFor, type PermissionId } from "@/lib/auth/permissions";
import type { UserRole } from "@/lib/auth/schemas";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

export type PermissionDeniedRequirement =
  | { action: PermissionId; requiredRole?: never }
  | { requiredRole: UserRole; action?: never };

export type PermissionDeniedProps = PermissionDeniedRequirement & {
  variant?: "page" | "inline";
  title?: string;
  description?: string;
  className?: string;
  children?: ReactNode;
};

function requiredRoleOf(requirement: PermissionDeniedRequirement): UserRole {
  return requirement.action === undefined
    ? requirement.requiredRole
    : requiredRoleFor(requirement.action);
}

function capitalized(role: UserRole): string {
  return `${role.charAt(0).toUpperCase()}${role.slice(1)}`;
}

export function PermissionDenied({
  variant = "page",
  title,
  description,
  className,
  children,
  ...requirement
}: PermissionDeniedProps) {
  const { role } = useCurrentRole();
  const requiredRole = requiredRoleOf(requirement);
  const signedInAs = role === null ? "" : ` You are signed in as a ${role}.`;

  if (variant === "inline") {
    return (
      <div
        data-slot="permission-denied"
        data-variant="inline"
        data-required-role={requiredRole}
        className={cn(
          "flex items-center gap-2 rounded-lg border border-dashed p-3 text-sm text-muted-foreground",
          className,
        )}
      >
        <Lock aria-hidden="true" className="size-4 shrink-0" />
        <span>{description ?? `This needs the ${requiredRole} role.${signedInAs}`}</span>
        {children}
      </div>
    );
  }

  return (
    <section
      data-slot="permission-denied"
      data-variant="page"
      data-required-role={requiredRole}
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center",
        className,
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <LockKeyhole aria-hidden="true" className="size-6" />
      </div>
      <h2 className="text-base font-semibold">
        {title ?? `${capitalized(requiredRole)} access required`}
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">
        {description ??
          `This page is limited to ${requiredRole}s.${signedInAs} Ask an admin if you need access.`}
      </p>
      {children}
      <Button asChild variant="outline">
        <Link href={routes.home}>Back to home</Link>
      </Button>
    </section>
  );
}
