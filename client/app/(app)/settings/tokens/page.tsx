import type { Metadata } from "next";
import { PageHeader } from "@/components/app-shell/page-header";
import { PageGate } from "@/components/page-gate";
import { RoleGate } from "@/components/role-gate";
import { CreateTokenDialog } from "@/features/tokens/components/create-token-dialog";
import { TokensView } from "@/features/tokens/components/tokens-view";

export const metadata: Metadata = { title: "Personal tokens" };

export default function TokensSettingsPage() {
  return (
    <>
      <PageHeader
        title="Personal tokens"
        description="Tokens that let Claude Code call Tessa as you. A token carries your role, expires, and is shown only once when you create it."
        actions={
          <RoleGate action="tokens.manage_own">
            <CreateTokenDialog />
          </RoleGate>
        }
      />
      <PageGate action="tokens.manage_own">
        <TokensView />
      </PageGate>
    </>
  );
}
