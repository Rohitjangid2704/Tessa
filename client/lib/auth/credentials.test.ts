import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CREDENTIALS_VERIFY_PATH,
  InvalidCredentialsError,
  RateLimitedError,
  ServiceUnavailableError,
  authorizeCredentials,
  verifyCredentials,
} from "./credentials";

vi.mock("next-auth", async () => {
  const errors = await import("@auth/core/errors");
  return { CredentialsSignin: errors.CredentialsSignin, AuthError: errors.AuthError };
});

const env = {
  API_INTERNAL_URL: "http://127.0.0.1:8000",
  API_SERVICE_KEY: "dev-only-service-key-0123456789abcdefgh",
};

const apiUser = {
  id: "01a0f6a3-7fa4-75e1-acdf-e605bc8317d6",
  email: "admin@tessa.local",
  name: "Admin",
  role: "admin",
};

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

async function failureOf(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

describe("verifyCredentials", () => {
  it("posts the credentials with the service key and returns the parsed user", async () => {
    fetchMock.mockResolvedValue(Response.json(apiUser));

    const user = await verifyCredentials("admin@tessa.local", "secret-pass", env);

    expect(user).toEqual(apiUser);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`http://127.0.0.1:8000${CREDENTIALS_VERIFY_PATH}`);
    expect(CREDENTIALS_VERIFY_PATH).toBe("/api/v1/auth/credentials/verify");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Service-Key")).toBe(env.API_SERVICE_KEY);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(init?.cache).toBe("no-store");
    expect(JSON.parse(String(init?.body))).toEqual({
      email: "admin@tessa.local",
      password: "secret-pass",
    });
  });

  it("maps a 401 to the invalid_credentials code", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { error: { code: "invalid_credentials", message: "no", request_id: "r", details: [] } },
        { status: 401 },
      ),
    );

    const error = await failureOf(verifyCredentials("a@b.test", "bad", env));

    expect(error).toBeInstanceOf(InvalidCredentialsError);
    expect(error).toMatchObject({ code: "invalid_credentials", type: "CredentialsSignin" });
  });

  it("maps a 429 to the rate_limited code", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { error: { code: "rate_limited" } },
        { status: 429, headers: { "Retry-After": "30" } },
      ),
    );

    const error = await failureOf(verifyCredentials("a@b.test", "bad", env));

    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error).toMatchObject({ code: "rate_limited" });
  });

  it.each([
    ["a 503", () => Promise.resolve(Response.json({}, { status: 503 }))],
    ["a 500", () => Promise.resolve(new Response("boom", { status: 500 }))],
    ["a 403 from a wrong service key", () => Promise.resolve(Response.json({}, { status: 403 }))],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
    ["a body that is not JSON", () => Promise.resolve(new Response("<html>", { status: 200 }))],
    [
      "a body without a role",
      () => Promise.resolve(Response.json({ id: "1", email: "a@b.test", name: "A" })),
    ],
    [
      "a body with an unknown role",
      () => Promise.resolve(Response.json({ ...apiUser, role: "root" })),
    ],
  ])("maps %s to the service_unavailable code", async (_label, respond) => {
    fetchMock.mockImplementation(respond);

    const error = await failureOf(verifyCredentials("a@b.test", "pass", env));

    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(error).toMatchObject({ code: "service_unavailable" });
  });
});

describe("authorizeCredentials", () => {
  it("validates the raw form values before calling the API", async () => {
    const missingPassword = await failureOf(authorizeCredentials({ email: "a@b.test" }, env));
    const emptyEmail = await failureOf(authorizeCredentials({ email: "  ", password: "x" }, env));
    const wrongTypes = await failureOf(authorizeCredentials({ email: 1, password: {} }, env));

    for (const error of [missingPassword, emptyEmail, wrongTypes]) {
      expect(error).toBeInstanceOf(InvalidCredentialsError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("trims the email and forwards the password untouched", async () => {
    fetchMock.mockResolvedValue(Response.json(apiUser));

    await authorizeCredentials(
      { email: "  admin@tessa.local ", password: " pass with spaces " },
      env,
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ email: "admin@tessa.local", password: " pass with spaces " });
  });
});
