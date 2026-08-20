import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToken } from "@/lib/auth/token-client";
import { unwrap } from "./unwrap";

const NOW = Date.parse("2026-10-01T10:00:00.000Z");

type Call = { url: string; authorization: string | null; requestId: string | null };

function tokenResponse(token: string) {
  return Response.json({ token, expires_at: new Date(NOW + 300_000).toISOString() });
}

async function loadClient() {
  vi.stubEnv("NEXT_PUBLIC_API_URL", "http://api.test");
  vi.resetModules();
  const tokenClient = await import("@/lib/auth/token-client");
  tokenClient.clearToken();
  return import("./client");
}

describe("api client", () => {
  const calls: Call[] = [];
  let apiHandler: (call: Call) => Response;
  let mintHandler: () => Response;

  beforeEach(() => {
    calls.length = 0;
    mintHandler = () => tokenResponse("token-1");
    apiHandler = () => Response.json({ status: "ok" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (typeof input === "string") {
          return mintHandler();
        }
        const request = new Request(input);
        const call: Call = {
          url: request.url,
          authorization: request.headers.get("Authorization"),
          requestId: request.headers.get("X-Request-ID"),
        };
        calls.push(call);
        return apiHandler(call);
      }),
    );
  });

  afterEach(() => {
    clearToken();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("targets the configured API origin and sends the minted bearer token", async () => {
    const { api } = await loadClient();

    const health = await unwrap(api.GET("/health"));

    expect(health.status).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://api.test/health");
    expect(calls[0]?.authorization).toBe("Bearer token-1");
    expect(calls[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("mints a fresh token and resends once when the API answers 401 token_expired", async () => {
    const { api } = await loadClient();
    const minted = ["token-1", "token-2"];
    mintHandler = () => tokenResponse(minted.shift() ?? "token-x");
    apiHandler = (call) =>
      call.authorization === "Bearer token-1"
        ? Response.json(
            { error: { code: "token_expired", message: "expired", request_id: "r", details: [] } },
            { status: 401 },
          )
        : Response.json({ status: "ok" });

    const health = await unwrap(api.GET("/health"));

    expect(health.status).toBe("ok");
    expect(calls.map((call) => call.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("exposes the same authed fetch it uses", async () => {
    const client = await loadClient();
    const response = await client.authedFetch(new Request("http://api.test/health"));

    expect(response.status).toBe(200);
    expect(calls[0]?.authorization).toBe("Bearer token-1");
  });
});
