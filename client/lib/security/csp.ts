export const CSP_ENFORCED_HEADER = "Content-Security-Policy";
export const CSP_REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only";
export const NONCE_HEADER = "x-nonce";

const NONCE_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

export type ContentSecurityPolicyInput = {
  nonce: string;
  isDevelopment: boolean;
  apiOrigin: string;
  formActionOrigins?: readonly string[];
};

export function createNonce(): string {
  return btoa(crypto.randomUUID());
}

export function cspHeaderName(enforce: boolean): string {
  return enforce ? CSP_ENFORCED_HEADER : CSP_REPORT_ONLY_HEADER;
}

export function originOf(url: string): string {
  return new URL(url).origin;
}

export function buildContentSecurityPolicy({
  nonce,
  isDevelopment,
  apiOrigin,
  formActionOrigins = [],
}: ContentSecurityPolicyInput): string {
  if (!NONCE_PATTERN.test(nonce)) {
    throw new Error("The CSP nonce must be base64 text.");
  }
  const scriptSources = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(isDevelopment ? ["'unsafe-eval'"] : []),
  ];
  const directives: Array<[string, readonly string[]]> = [
    ["default-src", ["'self'"]],
    ["script-src", scriptSources],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "blob:", "data:", apiOrigin]],
    ["media-src", ["'self'", "blob:", apiOrigin]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", ["'self'", apiOrigin, "ws:", "wss:"]],
    ["worker-src", ["'self'", "blob:"]],
    ["frame-src", ["blob:"]],
    ["frame-ancestors", ["'none'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'", ...formActionOrigins]],
  ];
  return directives.map(([name, sources]) => `${name} ${sources.join(" ")}`).join("; ");
}
