import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import type { ReactElement, ReactNode } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/lib/api/query-keys";
import { ADMIN_USER, MEMBER_USER, VIEWER_USER, toAuthUser } from "@/mocks/factories/users";
import { signInAs } from "@/tests/utils/api-session";
import { createTestQueryClient } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import { ROLE_RANK, roleAtLeast, useCan, useCurrentRole } from "./can";
import type { UserRole } from "./schemas";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

function renderWithClient<Result>(hook: () => Result) {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(hook, { wrapper });
}

const roles: UserRole[] = ["viewer", "member", "admin"];

describe("roleAtLeast", () => {
  it("orders viewer below member below admin", () => {
    expect(ROLE_RANK.viewer).toBeLessThan(ROLE_RANK.member);
    expect(ROLE_RANK.member).toBeLessThan(ROLE_RANK.admin);
  });

  it.each(roles.flatMap((role) => roles.map((minimum) => [role, minimum] as const)))(
    "role %s against minimum %s",
    (role, minimum) => {
      expect(roleAtLeast(role, minimum)).toBe(ROLE_RANK[role] >= ROLE_RANK[minimum]);
    },
  );

  it("fails closed when the role is unknown", () => {
    expect(roleAtLeast(null, "viewer")).toBe(false);
    expect(roleAtLeast(undefined, "viewer")).toBe(false);
  });
});

describe("useCan", () => {
  it("is false while the current user is loading and true once it is known", async () => {
    await signInAs(ADMIN_USER);
    const { result } = renderWithClient(() => useCan("viewer"));

    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));
  });

  it.each([
    [VIEWER_USER, { viewer: true, member: false, admin: false }],
    [MEMBER_USER, { viewer: true, member: true, admin: false }],
    [ADMIN_USER, { viewer: true, member: true, admin: true }],
  ])("reads the role from GET /users/me for %#", async (user, expected) => {
    await signInAs(user);
    const { result } = renderWithClient(() => ({
      viewer: useCan("viewer"),
      member: useCan("member"),
      admin: useCan("admin"),
      current: useCurrentRole(),
    }));

    await waitFor(() => expect(result.current.current.role).toBe(user.role));
    expect({
      viewer: result.current.viewer,
      member: result.current.member,
      admin: result.current.admin,
    }).toEqual(expected);
  });

  it("trusts GET /users/me over the role claim inside the token", async () => {
    await signInAs(ADMIN_USER);
    server.use(
      http.get("*/api/v1/users/me", () =>
        HttpResponse.json({
          id: ADMIN_USER.id,
          email: ADMIN_USER.email,
          name: ADMIN_USER.name,
          role: "viewer",
        }),
      ),
    );
    const { result } = renderWithClient(() => ({
      can: useCan("member"),
      current: useCurrentRole(),
    }));

    await waitFor(() => expect(result.current.current.role).toBe("viewer"));
    expect(result.current.can).toBe(false);
  });

  it("fails closed when GET /users/me fails", async () => {
    await signInAs(ADMIN_USER);
    server.use(http.get("*/api/v1/users/me", () => HttpResponse.error()));
    const { result } = renderWithClient(() => ({
      can: useCan("viewer"),
      current: useCurrentRole(),
    }));

    await waitFor(() => expect(result.current.current.isPending).toBe(false));
    expect(result.current.can).toBe(false);
    expect(result.current.current.role).toBeNull();
  });
});

function RoleProbe() {
  const { role, isPending } = useCurrentRole();
  const canWrite = useCan("member");
  return (
    <button type="button" disabled={isPending} data-role={role ?? "unknown"} data-can={canWrite}>
      Probe
    </button>
  );
}

function CanOnlyProbe() {
  const canWrite = useCan("member");
  return (
    <button type="button" disabled={!canWrite}>
      Write
    </button>
  );
}

function treeWith(client: QueryClient, ui: ReactElement): ReactElement {
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function cachedClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  client.setQueryData(qk.me(), toAuthUser(ADMIN_USER));
  return client;
}

function coldClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
}

async function hydrateAgainstColdServerHtml(ui: ReactElement, client: QueryClient) {
  const container = document.createElement("div");
  container.innerHTML = renderToString(treeWith(coldClient(), ui));
  document.body.append(container);
  const problems: string[] = [];
  const logged = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    problems.push(args.map(String).join(" "));
  });
  await act(async () => {
    hydrateRoot(container, treeWith(client, ui), {
      onRecoverableError: (error) => {
        problems.push(String(error));
      },
    });
  });
  logged.mockRestore();
  return { container, problems };
}

describe("hydrating with the current user already cached", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the pending role on the server and the same markup on the first client render", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(treeWith(coldClient(), <RoleProbe />));

    const button = container.querySelector("button");

    expect(button).toHaveAttribute("disabled");
    expect(button).toHaveAttribute("data-role", "unknown");
    expect(button).toHaveAttribute("data-can", "false");
  });

  it("reports a pending role through useCurrentRole until the page is hydrated", async () => {
    await signInAs(ADMIN_USER);
    const { problems, container } = await hydrateAgainstColdServerHtml(
      <RoleProbe />,
      cachedClient(),
    );

    expect(problems).toEqual([]);
    const button = container.querySelector("button");
    expect(button).not.toHaveAttribute("disabled");
    expect(button).toHaveAttribute("data-role", "admin");
    expect(button).toHaveAttribute("data-can", "true");
  });

  it("does not leave a disabled attribute from useCan stuck after hydration", async () => {
    await signInAs(ADMIN_USER);
    const { problems, container } = await hydrateAgainstColdServerHtml(
      <CanOnlyProbe />,
      cachedClient(),
    );

    expect(problems).toEqual([]);
    expect(container.querySelector("button")).not.toHaveAttribute("disabled");
  });

  it("keeps a viewer read-only after hydration without a mismatch", async () => {
    const client = cachedClient();
    client.setQueryData(qk.me(), toAuthUser(VIEWER_USER));

    const { problems, container } = await hydrateAgainstColdServerHtml(<CanOnlyProbe />, client);

    expect(problems).toEqual([]);
    expect(container.querySelector("button")).toHaveAttribute("disabled");
  });
});
