import { cookies } from "next/headers";
import { SIDEBAR_STATE_COOKIE } from "@/components/app-shell/sidebar-state";
import { TargetAwareShell } from "@/features/targets/target-aware-shell";
import { verifySession } from "@/lib/auth/dal";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { user } = await verifySession();
  const cookieStore = await cookies();
  const defaultOpen = cookieStore.get(SIDEBAR_STATE_COOKIE)?.value !== "false";

  return (
    <TargetAwareShell user={{ name: user.name, email: user.email }} defaultOpen={defaultOpen}>
      {children}
    </TargetAwareShell>
  );
}
