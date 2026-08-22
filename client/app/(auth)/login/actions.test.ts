import { AuthError, CallbackRouteError, CredentialsSignin } from "@auth/core/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loginAction, logoutAction } from "./actions";
import { initialLoginState } from "./login-state";

const signIn = vi.hoisted(() => vi.fn());
const signOut = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({ signIn, signOut }));

class RateLimited extends CredentialsSignin {
  code = "rate_limited";
}

function form(values: Record<string, string>) {
  const formData = new FormData();
  for (const [name, value] of Object.entries(values)) {
    formData.set(name, value);
  }
  return formData;
}

beforeEach(() => {
  signIn.mockReset();
  signOut.mockReset();
});

describe("loginAction", () => {
  it("rejects empty fields without calling Auth.js", async () => {
    const result = await loginAction(initialLoginState, form({ email: "  ", password: "" }));

    expect(result.error).toBe("validation_failed");
    expect(result.fieldErrors).toEqual({
      email: "Enter your email address.",
      password: "Enter your password.",
    });
    expect(signIn).not.toHaveBeenCalled();
  });

  it("keeps the email when only the password is missing", async () => {
    const result = await loginAction(initialLoginState, form({ email: "a@b.test" }));

    expect(result).toMatchObject({
      error: "validation_failed",
      email: "a@b.test",
      fieldErrors: { password: "Enter your password." },
    });
  });

  it("signs in with the credentials provider and a safe redirect target", async () => {
    signIn.mockRejectedValue(
      Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT" }),
    );

    await expect(
      loginAction(
        initialLoginState,
        form({ email: " a@b.test ", password: "pw", callbackUrl: "/runs?tab=events" }),
      ),
    ).rejects.toMatchObject({ digest: "NEXT_REDIRECT" });

    expect(signIn).toHaveBeenCalledWith("credentials", {
      email: "a@b.test",
      password: "pw",
      redirectTo: "/runs?tab=events",
    });
  });

  it.each(["//evil.example", "https://evil.example", "/login", "javascript:alert(1)", ""])(
    "replaces the unsafe callback %j with the home page",
    async (callbackUrl) => {
      signIn.mockRejectedValue(new Error("NEXT_REDIRECT"));

      await loginAction(
        initialLoginState,
        form({ email: "a@b.test", password: "pw", callbackUrl }),
      ).catch(() => undefined);

      expect(signIn.mock.calls[0]?.[1]).toMatchObject({ redirectTo: "/" });
    },
  );

  it("returns the error code and email when Auth.js rejects the credentials", async () => {
    signIn.mockRejectedValue(new CredentialsSignin());

    const result = await loginAction(
      initialLoginState,
      form({ email: "a@b.test", password: "bad" }),
    );

    expect(result).toEqual({ error: "invalid_credentials", fieldErrors: {}, email: "a@b.test" });
  });

  it("returns the specific code of a credentials error", async () => {
    signIn.mockRejectedValue(new RateLimited());

    const result = await loginAction(
      initialLoginState,
      form({ email: "a@b.test", password: "bad" }),
    );

    expect(result.error).toBe("rate_limited");
  });

  it("reports other Auth.js failures as service_unavailable", async () => {
    signIn.mockRejectedValue(new CallbackRouteError("boom"));
    const wrapped = await loginAction(
      initialLoginState,
      form({ email: "a@b.test", password: "pw" }),
    );

    signIn.mockRejectedValue(new AuthError("generic"));
    const generic = await loginAction(
      initialLoginState,
      form({ email: "a@b.test", password: "pw" }),
    );

    expect(wrapped.error).toBe("service_unavailable");
    expect(generic.error).toBe("service_unavailable");
  });

  it("rethrows errors that are not Auth.js errors", async () => {
    signIn.mockRejectedValue(new TypeError("unexpected"));

    await expect(
      loginAction(initialLoginState, form({ email: "a@b.test", password: "pw" })),
    ).rejects.toThrow("unexpected");
  });
});

describe("logoutAction", () => {
  it("signs out and returns to the login page", async () => {
    signOut.mockResolvedValue(undefined);

    await logoutAction();

    expect(signOut).toHaveBeenCalledWith({ redirectTo: "/login" });
  });
});
