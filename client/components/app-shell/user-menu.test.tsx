import { beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { MEMBER_USER } from "@/mocks/factories/users";
import { signInAs } from "@/tests/utils/api-session";
import { renderWithProviders, screen, userEvent } from "@/tests/utils/render";
import { UserMenu } from "./user-menu";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const session = vi.hoisted(() => ({ logout: vi.fn(), pending: false }));

vi.mock("@/lib/auth/use-logout", () => ({
  useLogout: () => ({ logout: session.logout, pending: session.pending }),
}));

function renderMenu() {
  return renderWithProviders(
    <SidebarProvider>
      <UserMenu user={{ name: "Session Name", email: "session@tessa.local" }} />
    </SidebarProvider>,
  );
}

beforeEach(async () => {
  session.logout.mockReset();
  session.pending = false;
  await signInAs(MEMBER_USER);
});

describe("UserMenu", () => {
  it("shows the session user first and the API's current user once it loads", async () => {
    renderMenu();

    expect(screen.getByText("Session Name")).toBeInTheDocument();
    expect(await screen.findByText("Member")).toBeInTheDocument();
    expect(screen.getByText("member@tessa.local")).toBeInTheDocument();
  });

  it("lists the role and signs out from the menu", async () => {
    const user = userEvent.setup();
    renderMenu();
    await screen.findByText("Member");

    await user.click(screen.getByRole("button", { name: /member@tessa.local/ }));
    expect(await screen.findByText("Role: member")).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));

    expect(session.logout).toHaveBeenCalledTimes(1);
  });

  it("disables sign out while a logout is pending", async () => {
    session.pending = true;
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole("button", { name: /session@tessa.local/ }));

    expect(await screen.findByRole("menuitem", { name: "Sign out" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("offers the theme toggle beside the account button", () => {
    renderMenu();

    expect(screen.getByRole("button", { name: "Change theme" })).toBeInTheDocument();
  });
});
