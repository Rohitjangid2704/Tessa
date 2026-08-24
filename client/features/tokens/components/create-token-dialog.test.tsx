import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/lib/api/query-keys";
import { VIEWER_USER } from "@/mocks/factories/users";
import { TOKEN_LIMIT, TOKEN_MAX_DAYS } from "@/mocks/stage11/tokens-data";
import { tokensStore } from "@/mocks/stage11/tokens-store";
import { signInAs } from "@/tests/utils/api-session";
import { createTestQueryClient, fireEvent, screen, userEvent, waitFor } from "@/tests/utils/render";
import { CreateTokenDialog } from "./create-token-dialog";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));

vi.mock("sonner", () => ({ toast: toastMocks }));

const SECRET_PATTERN = /ipt_[A-Za-z0-9_-]{43}/;

beforeEach(async () => {
  toastMocks.success.mockClear();
  toastMocks.error.mockClear();
  toastMocks.info.mockClear();
  await signInAs(VIEWER_USER);
});

function renderDialog() {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StrictMode>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </StrictMode>
  );
  return { queryClient, ...render(<CreateTokenDialog />, { wrapper }) };
}

async function createToken(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  expiry?: string,
): Promise<void> {
  await user.click(screen.getByRole("button", { name: "New token" }));
  await user.type(await screen.findByLabelText("Name"), name);
  if (expiry !== undefined) {
    await user.type(screen.getByLabelText(/Expires after/), expiry);
  }
  await user.click(screen.getByRole("button", { name: "Create token" }));
}

function tokenValue(): string | null {
  const field = document.querySelector<HTMLInputElement>('[data-slot="token-once-value"]');
  return field === null ? null : field.value;
}

describe("CreateTokenDialog token handling", () => {
  it("shows the token once with the warning, then drops it from the DOM when closed", async () => {
    const user = userEvent.setup();
    renderDialog();
    await createToken(user, "laptop");

    expect(await screen.findByText("This token is shown once")).toBeInTheDocument();
    const shown = tokenValue();
    expect(shown).toMatch(SECRET_PATTERN);
    expect(screen.getByLabelText("Personal token")).toHaveValue(shown);
    expect(screen.getByLabelText("Personal token")).toHaveAttribute("readonly");

    await user.click(screen.getByRole("button", { name: "I copied it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body.innerHTML).not.toContain(shown);
    expect(screen.queryByDisplayValue(shown ?? "")).not.toBeInTheDocument();
  });

  it("never keeps the token in the query cache, the mutation cache, a toast or storage", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderDialog();
    await createToken(user, "laptop");
    await screen.findByText("This token is shown once");
    const shown = tokenValue() ?? "";
    expect(shown).not.toBe("");

    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0));
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state),
      ),
    ).not.toContain(shown);

    await user.click(screen.getByRole("button", { name: "I copied it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    for (const mock of Object.values(toastMocks)) {
      expect(JSON.stringify(mock.mock.calls)).not.toContain(shown);
    }
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(shown);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(shown);
    expect(queryClient.getQueryData(qk.tokens.mine())).toBeUndefined();
  });

  it("starts empty when reopened and mints a different token", async () => {
    const user = userEvent.setup();
    renderDialog();
    await createToken(user, "first");
    await screen.findByText("This token is shown once");
    const first = tokenValue();
    await user.click(screen.getByRole("button", { name: "I copied it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "New token" }));
    expect(await screen.findByLabelText("Name")).toHaveValue("");
    expect(tokenValue()).toBeNull();
    await user.type(screen.getByLabelText("Name"), "second");
    await user.click(screen.getByRole("button", { name: "Create token" }));
    await screen.findByText("This token is shown once");
    expect(tokenValue()).toMatch(SECRET_PATTERN);
    expect(tokenValue()).not.toBe(first);
  });

  it("keeps the token dialog open on an outside click", async () => {
    const user = userEvent.setup();
    renderDialog();
    await createToken(user, "laptop");
    await screen.findByText("This token is shown once");
    const shown = tokenValue();

    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    expect(overlay).not.toBeNull();
    fireEvent.pointerDown(overlay as Element);
    fireEvent.pointerUp(overlay as Element);
    fireEvent.click(overlay as Element);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(tokenValue()).toBe(shown);
  });
});

describe("CreateTokenDialog errors", () => {
  it("validates the name before sending", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: "New token" }));
    await user.click(await screen.findByRole("button", { name: "Create token" }));
    expect(await screen.findByText("Enter a name for the token")).toBeInTheDocument();
    expect(tokensStore.listOf(VIEWER_USER.id)).toHaveLength(0);
  });

  it("shows the server maximum from the 422 detail", async () => {
    const user = userEvent.setup();
    renderDialog();
    await createToken(user, "long lived", String(TOKEN_MAX_DAYS + 1));

    expect(
      await screen.findByText(`The server allows at most ${TOKEN_MAX_DAYS} days`),
    ).toBeInTheDocument();
    expect(screen.getByText(`The server maximum is ${TOKEN_MAX_DAYS} days.`)).toBeInTheDocument();
    expect(screen.queryByText("This token is shown once")).not.toBeInTheDocument();
  });

  it("shows the token limit as an inline alert", async () => {
    tokensStore.load("full");
    const user = userEvent.setup();
    renderDialog();
    await createToken(user, "eleventh");

    const alert = await screen.findByText("Token limit reached");
    expect(alert).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`${TOKEN_LIMIT} active tokens`))).toBeInTheDocument();
    expect(toastMocks.error).not.toHaveBeenCalled();
  });
});
