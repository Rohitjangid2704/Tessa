import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REFRESH_MARGIN_MS,
  SessionExpiredError,
  TokenMintError,
  clearToken,
  getToken,
  refreshToken,
} from "./token-client";

const NOW = Date.parse("2026-10-01T10:00:00.000Z");
const TTL_MS = 300_000;

function mintResponse(token: string, expiresAtMs: number, headers: Record<string, string> = {}) {
  return Response.json({ token, expires_at: new Date(expiresAtMs).toISOString() }, { headers });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  clearToken();
});

afterEach(() => {
  clearToken();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("token manager", () => {
  it("mints from the same-origin route and reuses the cached token", async () => {
    fetchMock.mockImplementation(async () => mintResponse("token-1", NOW + TTL_MS));

    await expect(getToken()).resolves.toBe("token-1");
    await expect(getToken()).resolves.toBe("token-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/session/api-token");
    expect(init).toMatchObject({ method: "GET", cache: "no-store", credentials: "same-origin" });
  });

  it("shares one request between concurrent callers", async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValue(pending.promise);

    const first = getToken();
    const second = getToken();
    const third = refreshToken();
    pending.resolve(mintResponse("token-1", NOW + TTL_MS));

    await expect(Promise.all([first, second, third])).resolves.toEqual([
      "token-1",
      "token-1",
      "token-1",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes once the token is within 60 seconds of expiry", async () => {
    fetchMock
      .mockImplementationOnce(async () => mintResponse("token-1", NOW + TTL_MS))
      .mockImplementationOnce(async () => mintResponse("token-2", NOW + 2 * TTL_MS));

    await expect(getToken()).resolves.toBe("token-1");

    vi.setSystemTime(NOW + TTL_MS - REFRESH_MARGIN_MS - 1);
    await expect(getToken()).resolves.toBe("token-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + TTL_MS - REFRESH_MARGIN_MS);
    await expect(getToken()).resolves.toBe("token-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses a 60 second refresh margin", () => {
    expect(REFRESH_MARGIN_MS).toBe(60_000);
  });

  it("measures expiry on the server clock when the response has a Date header", async () => {
    const serverNow = NOW - 120_000;
    fetchMock
      .mockImplementationOnce(async () =>
        mintResponse("token-1", serverNow + TTL_MS, { date: new Date(serverNow).toUTCString() }),
      )
      .mockImplementationOnce(async () => mintResponse("token-2", serverNow + 2 * TTL_MS));

    await expect(getToken()).resolves.toBe("token-1");

    vi.setSystemTime(NOW + TTL_MS - REFRESH_MARGIN_MS - 1);
    await expect(getToken()).resolves.toBe("token-1");

    vi.setSystemTime(NOW + TTL_MS - REFRESH_MARGIN_MS);
    await expect(getToken()).resolves.toBe("token-2");
  });

  it("mints a new token after clearToken", async () => {
    fetchMock
      .mockImplementationOnce(async () => mintResponse("token-1", NOW + TTL_MS))
      .mockImplementationOnce(async () => mintResponse("token-2", NOW + TTL_MS));

    await expect(getToken()).resolves.toBe("token-1");
    clearToken();
    await expect(getToken()).resolves.toBe("token-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a mint that was started before clearToken", async () => {
    const stale = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(stale.promise)
      .mockImplementationOnce(async () => mintResponse("token-2", NOW + TTL_MS));

    const staleMint = getToken();
    clearToken();
    stale.resolve(mintResponse("token-1", NOW + TTL_MS));
    await staleMint;

    await expect(getToken()).resolves.toBe("token-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns the cached token when another caller already replaced the rejected one", async () => {
    fetchMock
      .mockImplementationOnce(async () => mintResponse("token-1", NOW + TTL_MS))
      .mockImplementationOnce(async () => mintResponse("token-2", NOW + TTL_MS));

    await getToken();
    await expect(refreshToken("token-0")).resolves.toBe("token-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(refreshToken("token-1")).resolves.toBe("token-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("raises SessionExpiredError on 401 and caches nothing", async () => {
    fetchMock.mockImplementation(async () => Response.json({ error: {} }, { status: 401 }));

    await expect(getToken()).rejects.toBeInstanceOf(SessionExpiredError);
    await expect(getToken()).rejects.toBeInstanceOf(SessionExpiredError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("raises TokenMintError with the status on other failures", async () => {
    fetchMock.mockImplementation(async () => new Response("boom", { status: 500 }));

    const error = await getToken().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TokenMintError);
    expect(error).toMatchObject({ status: 500 });
  });

  it("raises TokenMintError when the route cannot be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const error = await getToken().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TokenMintError);
    expect(error).toMatchObject({ status: null });
  });

  it.each([
    ["invalid JSON", () => new Response("not json", { status: 200 })],
    ["a body without a token", () => Response.json({ expires_at: new Date(NOW).toISOString() })],
    ["a body with a bad timestamp", () => Response.json({ token: "t", expires_at: "tomorrow" })],
  ])("raises TokenMintError for %s", async (_label, respond) => {
    fetchMock.mockImplementation(async () => respond());
    await expect(getToken()).rejects.toBeInstanceOf(TokenMintError);
  });

  it("keeps the token out of every browser storage", async () => {
    fetchMock.mockImplementation(async () => mintResponse("secret-token", NOW + TTL_MS));

    await getToken();

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
  });
});
