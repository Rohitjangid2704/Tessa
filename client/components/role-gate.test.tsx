import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { qk } from "@/lib/api/query-keys";
import { ADMIN_USER, MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import { signInAs } from "@/tests/utils/api-session";
import { renderWithProviders, screen, waitFor } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import { RoleGate } from "./role-gate";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

function renderGate(min: "viewer" | "member" | "admin") {
  return renderWithProviders(
    <RoleGate min={min} fallback={<p>denied</p>} pending={<p>checking</p>}>
      <button type="button">Start run</button>
    </RoleGate>,
  );
}

describe("RoleGate", () => {
  it("renders the pending content, never the children, while the role is unknown", async () => {
    await signInAs(ADMIN_USER);
    renderGate("viewer");

    expect(screen.getByText("checking")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start run" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Start run" })).toBeInTheDocument();
  });

  it("renders the children when the role meets the minimum", async () => {
    await signInAs(MEMBER_USER);
    renderGate("member");

    expect(await screen.findByRole("button", { name: "Start run" })).toBeInTheDocument();
    expect(screen.queryByText("denied")).not.toBeInTheDocument();
  });

  it("renders the fallback when the role is below the minimum", async () => {
    await signInAs(VIEWER_USER);
    renderGate("member");

    expect(await screen.findByText("denied")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start run" })).not.toBeInTheDocument();
  });

  it("renders nothing for a missing fallback", async () => {
    await signInAs(VIEWER_USER);
    const { container, queryClient } = renderWithProviders(
      <RoleGate min="admin">
        <button type="button">Delete</button>
      </RoleGate>,
    );

    await waitFor(() => expect(queryClient.getQueryData(qk.me())).toBeDefined());
    expect(container.querySelector("button")).toBeNull();
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
  });

  it("fails closed when the current user cannot be read", async () => {
    await signInAs(ADMIN_USER);
    server.use(http.get("*/api/v1/users/me", () => HttpResponse.error()));
    renderGate("viewer");

    expect(await screen.findByText("denied")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start run" })).not.toBeInTheDocument();
  });
});
