import { TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { describeReturnPath, readCallbackUrl } from "@/lib/auth/callback-url";
import { getSessionUser } from "@/lib/auth/dal";
import { getLoginOptions } from "@/lib/auth/login-options";
import { loginNoticeFromSearch } from "@/lib/auth/login-notices";
import { toRoute } from "@/lib/routes";
import { loginAction, ssoLoginAction } from "./actions";
import { LoginForm } from "./login-form";
import { LoginNotice, ReturnPathNote, SignInDivider } from "./login-notice";
import { SsoSignIn } from "./sso-sign-in";

export const metadata: Metadata = {
  title: "Sign in",
};

function describeSignInMethods(passwordEnabled: boolean, ssoName: string | null): string {
  if (ssoName !== null && passwordEnabled) {
    return `Use ${ssoName} or your Tessa account to continue.`;
  }
  if (ssoName !== null) {
    return `Use ${ssoName} to continue.`;
  }
  return "Use your Tessa account to continue.";
}

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  await connection();
  const query = await searchParams;
  const callbackUrl = readCallbackUrl(query.callbackUrl);

  if (await getSessionUser()) {
    redirect(toRoute(callbackUrl));
  }

  const { passwordEnabled, sso } = getLoginOptions();
  const notice = loginNoticeFromSearch(query.error, query.code);
  const returnPath = describeReturnPath(callbackUrl);

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1 className="text-lg font-semibold">Sign in to Tessa</h1>
          </CardTitle>
          <CardDescription>
            {describeSignInMethods(passwordEnabled, sso?.providerName ?? null)}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {notice ? <LoginNotice code={notice} passwordAvailable={passwordEnabled} /> : null}
          {returnPath ? <ReturnPathNote path={returnPath} /> : null}
          {sso ? (
            <SsoSignIn
              action={ssoLoginAction}
              callbackUrl={callbackUrl}
              providerName={sso.providerName}
            />
          ) : null}
          {sso && passwordEnabled ? <SignInDivider label="or use your password" /> : null}
          {passwordEnabled ? (
            <LoginForm action={loginAction} callbackUrl={callbackUrl} autoFocusEmail={!sso} />
          ) : null}
          {!sso && !passwordEnabled ? (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>Sign-in is not configured</AlertTitle>
              <AlertDescription>
                Neither password sign-in nor single sign-on is enabled. Ask an administrator to
                check the web service settings.
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
