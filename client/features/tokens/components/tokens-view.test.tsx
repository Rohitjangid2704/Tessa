import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_USER } from "@/mocks/factories/users";
import { tokensStore } from "@/mocks/stage11/tokens-store";
import { signInAs } from "@/tests/utils/api-session";
import { renderWithProviders, screen, userEvent, waitFor, within } from "@/tests/utils/render";
import { TokensView } from "./tokens-view";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

beforeEach(async () => {
  await signInAs(MEMBER_USER);
});

describe("TokensView", () => {
  it("shows the Connect panel before an empty table when there is no token", async () => {
    renderWithProviders(<TokensView />);
    expect(await screen.findByText("No tokens yet")).toBeInTheDocument();
    const connect = screen.getByText("Connect Claude Code");
    const empty = screen.getByText("No tokens yet");
    expect(connect.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("lists active, expired and revoked rows and offers revoke only on active ones", async () => {
    tokensStore.load("expired");
    renderWithProviders(<TokensView />);
    const table = await screen.findByRole("table", { name: "Personal tokens" });
    await waitFor(() =>
      expect(
        within(table)
          .getAllByRole("row")
          .filter((row) => row.getAttribute("data-token-id") !== null),
      ).toHaveLength(3),
    );
    const rows = within(table)
      .getAllByRole("row")
      .filter((row) => row.getAttribute("data-token-id") !== null);
    expect(rows.map((row) => row.getAttribute("data-state")).sort()).toEqual([
      "active",
      "expired",
      "revoked",
    ]);
    for (const row of rows) {
      const revoke = within(row).queryByRole("button", { name: /Revoke/ });
      expect(revoke !== null).toBe(row.getAttribute("data-state") === "active");
    }
    expect(within(table).getByText("Active")).toBeInTheDocument();
    expect(within(table).getByText("Expired")).toBeInTheDocument();
    expect(within(table).getByText("Revoked")).toBeInTheDocument();
    expect(screen.getByText("1 of 10 active tokens in use.")).toBeInTheDocument();
  });

  it("revokes a token after the name is typed", async () => {
    const user = userEvent.setup();
    tokensStore.mint(MEMBER_USER.id, "laptop", 30);
    renderWithProviders(<TokensView />);
    await user.click(await screen.findByRole("button", { name: /Revoke\s*laptop/ }));

    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Revoke token" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox"), "laptop");
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByRole("row", { name: /laptop/ })).toHaveAttribute("data-state", "revoked"),
    );
    expect(screen.queryByRole("button", { name: /Revoke\s*laptop/ })).not.toBeInTheDocument();
  });
});
