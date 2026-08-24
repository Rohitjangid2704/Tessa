"use client";

import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { meQuery } from "@/features/system/queries";
import type { User } from "@/lib/api/types";

export function UserIdentity({ user }: { user: User }) {
  const me = useQuery(meQuery());
  const isSelf = me.data?.id === user.id;
  return (
    <div data-slot="user-identity" className="flex min-w-0 flex-col">
      <span className="flex flex-wrap items-center gap-2 font-medium">
        {user.name}
        {isSelf ? <Badge variant="secondary">You</Badge> : null}
      </span>
      <span className="truncate text-xs text-muted-foreground">{user.email}</span>
    </div>
  );
}
