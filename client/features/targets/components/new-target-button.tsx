"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { RoleGate } from "@/components/role-gate";
import { Button } from "@/components/ui/button";
import { targetRoutes } from "@/lib/routes";

export function NewTargetButton() {
  return (
    <RoleGate action="targets.create">
      <Button asChild>
        <Link href={targetRoutes.create()}>
          <Plus aria-hidden="true" data-icon="inline-start" />
          New target
        </Link>
      </Button>
    </RoleGate>
  );
}
