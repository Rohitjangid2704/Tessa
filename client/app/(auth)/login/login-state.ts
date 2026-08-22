import type { LoginErrorCode } from "@/lib/auth/login-errors";

export type LoginFormError = LoginErrorCode | "validation_failed";

export type LoginFieldErrors = {
  email?: string;
  password?: string;
};

export type LoginFormState = {
  error: LoginFormError | null;
  fieldErrors: LoginFieldErrors;
  email: string;
  retryAfterSeconds?: number;
};

export const initialLoginState: LoginFormState = {
  error: null,
  fieldErrors: {},
  email: "",
};

export type LoginAction = (state: LoginFormState, formData: FormData) => Promise<LoginFormState>;
