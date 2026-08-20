import { AuthError, CallbackRouteError, CredentialsSignin, MissingSecret } from "@auth/core/errors";
import { describe, expect, it } from "vitest";
import {
  isLoginErrorCode,
  loginErrorFromSearch,
  loginErrorMessages,
  loginErrorCodes,
  resolveLoginError,
} from "./login-errors";

class RateLimited extends CredentialsSignin {
  code = "rate_limited";
}

class Unavailable extends CredentialsSignin {
  code = "service_unavailable";
}

class Invalid extends CredentialsSignin {
  code = "invalid_credentials";
}

describe("resolveLoginError", () => {
  it("reads the credentials error code", () => {
    expect(resolveLoginError(new Invalid())).toBe("invalid_credentials");
    expect(resolveLoginError(new RateLimited())).toBe("rate_limited");
    expect(resolveLoginError(new Unavailable())).toBe("service_unavailable");
  });

  it("treats Auth.js's default credentials code as invalid credentials", () => {
    expect(resolveLoginError(new CredentialsSignin())).toBe("invalid_credentials");
  });

  it("maps every other Auth.js error to service_unavailable", () => {
    expect(resolveLoginError(new CallbackRouteError("boom"))).toBe("service_unavailable");
    expect(resolveLoginError(new MissingSecret("no secret"))).toBe("service_unavailable");
    expect(resolveLoginError(new AuthError("generic"))).toBe("service_unavailable");
  });

  it("leaves framework errors such as redirects to the caller", () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/;307;",
    });

    expect(resolveLoginError(redirect)).toBeNull();
    expect(resolveLoginError(new Error("plain"))).toBeNull();
    expect(resolveLoginError("text")).toBeNull();
    expect(resolveLoginError(null)).toBeNull();
  });
});

describe("loginErrorFromSearch", () => {
  it("returns null when Auth.js reported nothing", () => {
    expect(loginErrorFromSearch(undefined, undefined)).toBeNull();
    expect(loginErrorFromSearch("", "invalid_credentials")).toBeNull();
  });

  it("reads the credentials code from the redirect", () => {
    expect(loginErrorFromSearch("CredentialsSignin", "rate_limited")).toBe("rate_limited");
    expect(loginErrorFromSearch(["CredentialsSignin"], ["service_unavailable"])).toBe(
      "service_unavailable",
    );
    expect(loginErrorFromSearch("CredentialsSignin", "credentials")).toBe("invalid_credentials");
    expect(loginErrorFromSearch("CredentialsSignin", undefined)).toBe("invalid_credentials");
  });

  it("maps any other Auth.js error type to service_unavailable", () => {
    expect(loginErrorFromSearch("Configuration", undefined)).toBe("service_unavailable");
  });
});

describe("login error codes", () => {
  it("has a message for every code", () => {
    for (const code of loginErrorCodes) {
      expect(isLoginErrorCode(code)).toBe(true);
      expect(loginErrorMessages[code].length).toBeGreaterThan(0);
    }
    expect(isLoginErrorCode("credentials")).toBe(false);
    expect(isLoginErrorCode(undefined)).toBe(false);
  });

  it("does not reveal whether the email or the password was wrong", () => {
    expect(loginErrorMessages.invalid_credentials.toLowerCase()).toContain("email or password");
  });
});
