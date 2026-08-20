import createClient from "openapi-fetch";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { components, paths } from "./schema";
import { ApiError } from "./errors";
import { unwrap } from "./unwrap";

function clientWith(respond: (request: Request) => Response) {
  const fetchMock = vi.fn(async (request: Request) => respond(request));
  return {
    client: createClient<paths>({ baseUrl: "http://api.test", fetch: fetchMock }),
    fetchMock,
  };
}

describe("unwrap", () => {
  it("returns typed data from a successful call", async () => {
    const { client } = clientWith(() =>
      Response.json({ id: "u1", email: "a@b.test", name: "A", role: "admin" }),
    );

    const user = await unwrap(client.GET("/api/v1/users/me"));

    expectTypeOf(user).toEqualTypeOf<components["schemas"]["AuthUser"]>();
    expect(user.role).toBe("admin");
  });

  it("throws an ApiError built from the contract body", async () => {
    const { client } = clientWith(() =>
      Response.json(
        {
          error: {
            code: "forbidden",
            message: "Not allowed",
            request_id: "req-9",
            details: [],
          },
        },
        { status: 403 },
      ),
    );

    const error = await unwrap(client.GET("/api/v1/users/me")).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: "forbidden", requestId: "req-9" });
  });

  it("throws for an error response with an empty body", async () => {
    const { client } = clientWith(() => new Response(null, { status: 502 }));

    const error = await unwrap(client.GET("/health")).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ status: 502, code: "upstream_error" });
  });

  it("passes the typed idempotency header and body through the client", async () => {
    const { client, fetchMock } = clientWith(() =>
      Response.json(
        {
          run_id: "r1",
          workflow_id: "hello-r1",
          kind: "hello",
          status: "queued",
          created_at: "2026-10-01T10:00:00.000Z",
        },
        { status: 202 },
      ),
    );

    const handle = await unwrap(
      client.POST("/api/v1/system/hello-runs", {
        params: { header: { "Idempotency-Key": "key-12345678" } },
        body: { ticks: 3, tick_interval_ms: 500, include_laya: false },
      }),
    );

    expect(handle.kind).toBe("hello");
    const request = fetchMock.mock.calls[0]?.[0];
    expect(request?.headers.get("Idempotency-Key")).toBe("key-12345678");
    await expect(request?.json()).resolves.toEqual({
      ticks: 3,
      tick_interval_ms: 500,
      include_laya: false,
    });
  });
});
