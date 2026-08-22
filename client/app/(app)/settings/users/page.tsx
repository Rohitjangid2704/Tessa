import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-shell/page-header";
import { PageGate } from "@/components/page-gate";
import { RoleGate } from "@/components/role-gate";
import { Skeleton } from "@/components/ui/skeleton";
import { CreateUserDialog } from "@/features/users/components/create-user-dialog";
import { UsersView } from "@/features/users/components/users-view";

export const metadata: Metadata = { title: "User management" };

function UsersFallback() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading users</span>
      <Skeleton className="h-8 w-full max-w-xl" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

export default function UsersSettingsPage() {
  return (
    <>
      <PageHeader
        title="Users"
        description="Everyone who can sign in to Tessa, what they can do and which teams they belong to."
        actions={
          <RoleGate action="users.manage">
            <CreateUserDialog />
          </RoleGate>
        }
      />
      <PageGate action="users.manage">
        <Suspense fallback={<UsersFallback />}>
          <UsersView />
        </Suspense>
      </PageGate>
    </>
  );
}
