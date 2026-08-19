import { NextResponse } from "next/server";
import type { NextFetchEvent, NextMiddleware, NextRequest } from "next/server";
import { auth } from "@/auth";
import { resolveSsoConfig } from "@/lib/auth/sso-config";
import { clientEnv } from "@/lib/env.client";
import { getServerEnv } from "@/lib/env.server";
import {
  CSP_ENFORCED_HEADER,
  CSP_REPORT_ONLY_HEADER,
  NONCE_HEADER,
  buildContentSecurityPolicy,
  createNonce,
  cspHeaderName,
  originOf,
} from "@/lib/security/csp";

type AuthGateWrapper = (
  handler: (request: NextRequest) => NextResponse,
) => NextMiddleware | Promise<NextMiddleware>;

const withAuthGate = auth as unknown as AuthGateWrapper;

function respondWithContentSecurityPolicy(request: NextRequest): NextResponse {
  const env = getServerEnv();
  const sso = resolveSsoConfig(env);
  const nonce = createNonce();
  const policy = buildContentSecurityPolicy({
    nonce,
    isDevelopment: process.env.NODE_ENV === "development",
    apiOrigin: originOf(clientEnv.NEXT_PUBLIC_API_URL),
    formActionOrigins: sso ? [originOf(sso.issuer)] : [],
  });
  const headerName = cspHeaderName(env.CSP_ENFORCE);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete(CSP_ENFORCED_HEADER);
  requestHeaders.delete(CSP_REPORT_ONLY_HEADER);
  requestHeaders.set(NONCE_HEADER, nonce);
  requestHeaders.set(headerName, policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(headerName, policy);
  return response;
}

export async function proxy(request: NextRequest, event: NextFetchEvent) {
  const gatedProxy = await withAuthGate(respondWithContentSecurityPolicy);
  return gatedProxy(request, event);
}

export const config = {
  matcher: [
    "/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|css|js|map|woff|woff2)$).*)",
  ],
};
