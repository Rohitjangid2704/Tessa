import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLogout } from "./use-logout";

const clearToken = vi.hoisted(() => vi.fn());
const logoutAction = vi.hoisted(() => vi.fn());

vi.mock("./token-client", () => ({ clearToken }));
vi.mock("@/app/(auth)/login/actions", () => ({ logoutAction }));

beforeEach(() => {
  clearToken.mockClear();
  logoutAction.mockReset();
  logoutAction.mockResolvedValue(undefined);
});

describe("useLogout", () => {
  it("drops the in-memory token and every cached query before signing out", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["me"], { id: "u1" });
    const order: string[] = [];
    clearToken.mockImplementation(() => order.push("clearToken"));
    logoutAction.mockImplementation(async () => {
      order.push("logoutAction");
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useLogout(), { wrapper });

    act(() => result.current.logout());

    await waitFor(() => expect(logoutAction).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["clearToken", "logoutAction"]);
    expect(queryClient.getQueryData(["me"])).toBeUndefined();
    await waitFor(() => expect(result.current.pending).toBe(false));
  });
});
