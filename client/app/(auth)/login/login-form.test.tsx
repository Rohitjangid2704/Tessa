import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loginErrorMessages } from "@/lib/auth/login-errors";
import { LoginForm } from "./login-form";
import { initialLoginState, type LoginAction, type LoginFormState } from "./login-state";

const clearToken = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/token-client", () => ({ clearToken }));

function state(overrides: Partial<LoginFormState>): LoginFormState {
  return { ...initialLoginState, ...overrides };
}

function actionReturning(next: LoginFormState) {
  return vi.fn<LoginAction>(async () => next);
}

async function submit(email: string, password: string) {
  const user = userEvent.setup();
  if (email) {
    await user.type(screen.getByLabelText("Email"), email);
  }
  if (password) {
    await user.type(screen.getByLabelText("Password"), password);
  }
  await user.click(screen.getByRole("button", { name: /sign in/i }));
}

beforeEach(() => {
  clearToken.mockClear();
});

describe("LoginForm", () => {
  it("renders the idle state with email focused and autocomplete hints", () => {
    render(<LoginForm action={actionReturning(initialLoginState)} callbackUrl="/runs" />);

    const email = screen.getByLabelText("Email");
    const password = screen.getByLabelText("Password");
    expect(email).toHaveFocus();
    expect(email).toHaveAttribute("type", "email");
    expect(email).toHaveAttribute("autocomplete", "username");
    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveAttribute("autocomplete", "current-password");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("drops any in-memory API token when it mounts", () => {
    render(<LoginForm action={actionReturning(initialLoginState)} callbackUrl="/" />);

    expect(clearToken).toHaveBeenCalledTimes(1);
  });

  it("submits the credentials and the callback url to the action", async () => {
    const action = actionReturning(initialLoginState);
    render(<LoginForm action={action} callbackUrl="/runs?tab=events" />);

    await submit("admin@tessa.local", "dev-only-admin-password-1");

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const formData = action.mock.calls[0]?.[1];
    expect(formData?.get("email")).toBe("admin@tessa.local");
    expect(formData?.get("password")).toBe("dev-only-admin-password-1");
    expect(formData?.get("callbackUrl")).toBe("/runs?tab=events");
  });

  it("shows a pending state and blocks a second submit while the action runs", async () => {
    let finish: (value: LoginFormState) => void = () => undefined;
    const action = vi.fn<LoginAction>(
      () =>
        new Promise<LoginFormState>((resolve) => {
          finish = resolve;
        }),
    );
    render(<LoginForm action={action} callbackUrl="/" />);

    await submit("a@b.test", "pw");

    const button = await screen.findByRole("button", { name: /signing in/i });
    expect(button).toBeDisabled();
    expect(button.closest("form")).toHaveAttribute("aria-busy", "true");

    finish(initialLoginState);
    await screen.findByRole("button", { name: "Sign in" });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it.each(["invalid_credentials", "rate_limited", "service_unavailable"] as const)(
    "shows the %s message in an alert and keeps the email",
    async (code) => {
      const action = actionReturning(state({ error: code, email: "a@b.test" }));
      render(<LoginForm action={action} callbackUrl="/" />);

      await submit("a@b.test", "pw");

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(loginErrorMessages[code]);
      expect(screen.getByLabelText("Email")).toHaveValue("a@b.test");
      expect(screen.getByLabelText("Password")).toHaveValue("");
    },
  );

  it("shows field errors from validation and marks the fields invalid", async () => {
    const action = actionReturning(
      state({
        error: "validation_failed",
        fieldErrors: { email: "Enter your email address.", password: "Enter your password." },
      }),
    );
    render(<LoginForm action={action} callbackUrl="/" />);

    await submit("", "");

    expect(await screen.findByText("Enter your email address.")).toHaveAttribute("role", "alert");
    expect(screen.getByText("Enter your password.")).toHaveAttribute("role", "alert");
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Email")).toHaveAccessibleDescription("Enter your email address.");
    expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
  });

  it("shows an error handed over by Auth.js on first render", () => {
    render(
      <LoginForm
        action={actionReturning(initialLoginState)}
        callbackUrl="/"
        initialError="rate_limited"
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(loginErrorMessages.rate_limited);
  });

  it("does not reveal which credential was wrong", async () => {
    const action = actionReturning(state({ error: "invalid_credentials" }));
    render(<LoginForm action={action} callbackUrl="/" />);

    await submit("a@b.test", "pw");

    expect(await screen.findByRole("alert")).toHaveTextContent(/email or password/i);
  });
});
