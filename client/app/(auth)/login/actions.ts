"use server";

import { redirect } from "next/navigation";
import { signIn, signOut } from "@/auth";
import { DEFAULT_CALLBACK_URL, parseCallbackUrl } from "@/lib/auth/callback-url";
import {
  isAuthJsError,
  resolveLoginError,
  resolveRetryAfterSeconds,
} from "@/lib/auth/login-errors";
import { loginInputSchema } from "@/lib/auth/schemas";
import { SSO_PROVIDER_ID } from "@/lib/auth/sso-config";
import { routes, toRoute } from "@/lib/routes";
import type { LoginFieldErrors, LoginFormState } from "./login-state";

function readText(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export async function loginAction(
  _previous: LoginFormState,
  formData: FormData,
): Promise<LoginFormState> {
  const submitted = {
    email: readText(formData, "email"),
    password: readText(formData, "password"),
  };
  const parsed = loginInputSchema.safeParse(submitted);
  if (!parsed.success) {
    const fieldErrors: LoginFieldErrors = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if ((field === "email" || field === "password") && !fieldErrors[field]) {
        fieldErrors[field] = issue.message;
      }
    }
    return { error: "validation_failed", fieldErrors, email: submitted.email };
  }

  const redirectTo = parseCallbackUrl(readText(formData, "callbackUrl"));
  try {
    await signIn("credentials", {
      email: parsed.data.email,
      password: parsed.data.password,
      redirectTo,
    });
  } catch (error) {
    const code = resolveLoginError(error);
    if (code === null) {
      throw error;
    }
    const retryAfterSeconds = resolveRetryAfterSeconds(error);
    return {
      error: code,
      fieldErrors: {},
      email: parsed.data.email,
      ...(retryAfterSeconds === null ? {} : { retryAfterSeconds }),
    };
  }
  return { error: null, fieldErrors: {}, email: parsed.data.email };
}

export async function ssoLoginAction(formData: FormData): Promise<void> {
  const callbackUrl = parseCallbackUrl(readText(formData, "callbackUrl"));
  try {
    await signIn(SSO_PROVIDER_ID, { redirectTo: callbackUrl });
  } catch (error) {
    if (!isAuthJsError(error)) {
      throw error;
    }
    const query = new URLSearchParams({ error: "Configuration" });
    if (callbackUrl !== DEFAULT_CALLBACK_URL) {
      query.set("callbackUrl", callbackUrl);
    }
    redirect(toRoute(`${routes.login}?${query.toString()}`));
  }
}

export async function logoutAction(): Promise<void> {
  await signOut({ redirectTo: routes.login });
}
