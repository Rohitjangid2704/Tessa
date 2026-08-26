import { http, HttpResponse } from "msw";
import { clearToken } from "@/lib/auth/token-client";
import { server } from "./server";
import { mintApiToken, type MintApiTokenOptions } from "./tokens";

const TOKEN_LIFETIME_MS = 300_000;

export async function signInAs(user?: MintApiTokenOptions["user"]): Promise<void> {
  clearToken();
  const token = await mintApiToken({ user });
  server.use(
    http.get("*/api/session/api-token", () =>
      HttpResponse.json({
        token,
        expires_at: new Date(Date.now() + TOKEN_LIFETIME_MS).toISOString(),
      }),
    ),
  );
}
