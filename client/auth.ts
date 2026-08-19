import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import type { Provider } from "next-auth/providers";
import { NextResponse } from "next/server";
import { authorizeCredentials } from "@/lib/auth/credentials";
import { decideGate } from "@/lib/auth/gate";
import { completeSsoSignIn, createSsoProvider } from "@/lib/auth/sso";
import { SSO_PROVIDER_ID, resolveSsoConfig } from "@/lib/auth/sso-config";
import { getServerEnv } from "@/lib/env.server";
import { routes } from "@/lib/routes";

export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const env = getServerEnv();
  const sso = resolveSsoConfig(env);
  const providers: Provider[] = [];
  if (env.AUTH_PASSWORD_LOGIN_ENABLED) {
    providers.push(
      Credentials({
        credentials: { email: {}, password: {} },
        authorize: (credentials) => authorizeCredentials(credentials, env),
      }),
    );
  }
  if (sso) {
    providers.push(createSsoProvider(sso));
  }
  return {
    secret: env.AUTH_SECRET,
    providers,
    session: { strategy: "jwt", maxAge: env.AUTH_SESSION_MAX_AGE_SECONDS },
    pages: { signIn: routes.login, error: routes.login },
    callbacks: {
      authorized({ request, auth: session }) {
        const decision = decideGate({
          pathname: request.nextUrl.pathname,
          search: request.nextUrl.search,
          isAuthenticated: Boolean(session?.user),
          callbackUrl: request.nextUrl.searchParams.get("callbackUrl"),
        });
        if (decision.action === "redirect") {
          return NextResponse.redirect(new URL(decision.location, request.nextUrl));
        }
        return true;
      },
      async signIn({ user, account, profile }) {
        if (account?.provider !== SSO_PROVIDER_ID) {
          return true;
        }
        if (sso === null) {
          return false;
        }
        return completeSsoSignIn({ user, profile }, sso, env);
      },
      jwt({ token, user }) {
        if (user) {
          token.id = user.id;
          token.role = user.role;
        }
        return token;
      },
      session({ session, token }) {
        session.user.id = token.id ?? token.sub ?? "";
        session.user.role = token.role ?? "viewer";
        return session;
      },
    },
  };
});
