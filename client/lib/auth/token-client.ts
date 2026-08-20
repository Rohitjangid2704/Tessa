import { routes } from "@/lib/routes";
import { apiTokenResponseSchema } from "./schemas";

export const REFRESH_MARGIN_MS = 60_000;

export class SessionExpiredError extends Error {
  constructor() {
    super("The session has expired");
    this.name = "SessionExpiredError";
  }
}

export class TokenMintError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TokenMintError";
    this.status = status;
  }
}

type CachedToken = {
  token: string;
  refreshAtMs: number;
};

let cachedToken: CachedToken | null = null;
let inflightMint: Promise<string> | null = null;
let generation = 0;

function serverClockSkewMs(response: Response, receivedAtMs: number): number {
  const serverNowMs = Date.parse(response.headers.get("date") ?? "");
  return Number.isNaN(serverNowMs) ? 0 : serverNowMs - receivedAtMs;
}

async function requestToken(): Promise<{ token: string; refreshAtMs: number }> {
  let response: Response;
  try {
    response = await fetch(routes.apiToken, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch (cause) {
    throw new TokenMintError("Could not reach the session service", null, { cause });
  }
  const receivedAtMs = Date.now();

  if (response.status === 401) {
    throw new SessionExpiredError();
  }
  if (!response.ok) {
    throw new TokenMintError(
      `Token request failed with status ${response.status}`,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new TokenMintError("Token response was not valid JSON", response.status, { cause });
  }
  const parsed = apiTokenResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new TokenMintError("Token response had an unexpected shape", response.status);
  }

  const expiresAtMs =
    Date.parse(parsed.data.expires_at) - serverClockSkewMs(response, receivedAtMs);
  return { token: parsed.data.token, refreshAtMs: expiresAtMs - REFRESH_MARGIN_MS };
}

function mint(): Promise<string> {
  if (inflightMint) {
    return inflightMint;
  }
  const mintGeneration = generation;
  const pending = requestToken()
    .then((minted) => {
      if (mintGeneration === generation) {
        cachedToken = minted;
      }
      return minted.token;
    })
    .finally(() => {
      if (inflightMint === pending) {
        inflightMint = null;
      }
    });
  inflightMint = pending;
  return pending;
}

function isUsable(candidate: CachedToken | null): candidate is CachedToken {
  return candidate !== null && Date.now() < candidate.refreshAtMs;
}

export function getToken(): Promise<string> {
  if (isUsable(cachedToken)) {
    return Promise.resolve(cachedToken.token);
  }
  return mint();
}

export function refreshToken(rejectedToken?: string): Promise<string> {
  if (rejectedToken !== undefined && isUsable(cachedToken) && cachedToken.token !== rejectedToken) {
    return Promise.resolve(cachedToken.token);
  }
  return mint();
}

export function clearToken(): void {
  generation += 1;
  cachedToken = null;
  inflightMint = null;
}
