"use client";

import { Loader2, TriangleAlert } from "lucide-react";
import { useActionState, useEffect } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { loginErrorMessage, type LoginErrorCode } from "@/lib/auth/login-errors";
import { clearToken } from "@/lib/auth/token-client";
import { initialLoginState, type LoginAction } from "./login-state";

export type LoginFormProps = {
  action: LoginAction;
  callbackUrl: string;
  initialError?: LoginErrorCode | null;
  autoFocusEmail?: boolean;
};

export function LoginForm({
  action,
  callbackUrl,
  initialError = null,
  autoFocusEmail = true,
}: LoginFormProps) {
  const [state, formAction, pending] = useActionState(action, {
    ...initialLoginState,
    error: initialError,
  });

  useEffect(() => {
    clearToken();
  }, []);

  const bannerMessage =
    state.error !== null && state.error !== "validation_failed"
      ? loginErrorMessage(state.error, state.retryAfterSeconds)
      : null;

  return (
    <form action={formAction} noValidate className="flex flex-col gap-5" aria-busy={pending}>
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      {bannerMessage ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>{bannerMessage}</AlertDescription>
        </Alert>
      ) : null}
      <FieldGroup>
        <Field data-invalid={state.fieldErrors.email ? true : undefined}>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            autoFocus={autoFocusEmail}
            required
            defaultValue={state.email}
            aria-invalid={state.fieldErrors.email ? true : undefined}
            aria-describedby={state.fieldErrors.email ? "email-error" : undefined}
          />
          <FieldError id="email-error">{state.fieldErrors.email}</FieldError>
        </Field>
        <Field data-invalid={state.fieldErrors.password ? true : undefined}>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            aria-invalid={state.fieldErrors.password ? true : undefined}
            aria-describedby={state.fieldErrors.password ? "password-error" : undefined}
          />
          <FieldError id="password-error">{state.fieldErrors.password}</FieldError>
        </Field>
      </FieldGroup>
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? (
          <>
            <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
            Signing in
          </>
        ) : (
          "Sign in"
        )}
      </Button>
    </form>
  );
}
